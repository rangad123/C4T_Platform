import { Router } from 'express'
import { z } from 'zod'
import { Role, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, requireRole } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { paymentRevealLimiter } from '../../middleware/rateLimit.js'
import { PERMISSIONS } from '../../config/permissions.js'
import { NotFoundError, UnauthorizedError, BadRequestError } from '../../lib/errors.js'
import { verifyPassword } from '../../lib/password.js'
import { encryptPaymentDetails, maskPaymentDetails } from '../../lib/payment-encryption.js'
import { revealPaymentAccount } from './payment-accounts.reveal.js'
import { recordAudit } from '../../lib/audit.js'

/**
 * §14-20 — tester payout accounts. Recovers legacy `payment_acc_details`.
 *
 * ── The masking boundary
 *
 * `payment_accounts.secure_details` (AES-256-GCM ciphertext) must never
 * appear in an ordinary API response. Every handler in this file uses
 * `maskedSelect` below, which lists every column EXCEPT `secureDetails` —
 * there is no handler here that uses a bare `include` on this model, which
 * would pull the ciphertext column in unnoticed. The one thing that DOES
 * decrypt (`POST /:id/reveal`) delegates to `payment-accounts.reveal.ts`,
 * a separate file with exactly one exported function, so "add a field to
 * this response" can never accidentally become "add the plaintext".
 */
export const paymentAccountsRouter = Router()

paymentAccountsRouter.use(authenticate)

const maskedSelect = {
  id: true,
  userId: true,
  country: true,
  paymentType: true,
  status: true,
  bankName: true,
  branchName: true,
  accountNumberLast4: true,
  paypalEmailMasked: true,
  paytmNumberLast4: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentAccountSelect

const upsertBody = z
  .object({
    country: z.enum(['INDIAN', 'NON_INDIAN']),
    paymentType: z.enum(['IND_BANK_ACCOUNT', 'NON_IND_BANK_ACCOUNT', 'PAYPAL', 'PAYTM']),
    bankName: z.string().trim().max(255).optional(),
    branchName: z.string().trim().max(255).optional(),
    accountName: z.string().trim().max(255).optional(),
    accountNumber: z.string().trim().max(25).optional(),
    ifscCode: z.string().trim().max(25).optional(),
    paypalEmail: z.string().trim().email().max(255).optional(),
    paytmNumber: z.string().trim().max(10).optional(),
  })
  .refine(
    (d) =>
      d.paymentType !== 'IND_BANK_ACCOUNT' && d.paymentType !== 'NON_IND_BANK_ACCOUNT'
        ? true
        : Boolean(d.accountNumber),
    { message: 'Account number is required for a bank account', path: ['accountNumber'] },
  )
  .refine((d) => (d.paymentType !== 'PAYPAL' ? true : Boolean(d.paypalEmail)), {
    message: 'PayPal email is required for a PayPal payout method',
    path: ['paypalEmail'],
  })
  .refine((d) => (d.paymentType !== 'PAYTM' ? true : Boolean(d.paytmNumber)), {
    message: 'Paytm number is required for a Paytm payout method',
    path: ['paytmNumber'],
  })

/**
 * The caller's own account, masked. `PaymentAccount.userId` is unique, so
 * this is a single-row lookup, not a list — a tester replaces their payout
 * method by editing this row, they don't accumulate several.
 */
paymentAccountsRouter.get('/mine', requireRole(Role.TESTER), async (req, res) => {
  const row = await prisma.paymentAccount.findUnique({
    where: { userId: req.user!.id },
    select: maskedSelect,
  })
  res.json({ data: row })
})

paymentAccountsRouter.put(
  '/mine',
  requireRole(Role.TESTER),
  validate({ body: upsertBody }),
  async (req, res) => {
    const input = req.body as z.infer<typeof upsertBody>
    const userId = req.user!.id

    const plain = {
      accountName: input.accountName,
      accountNumber: input.accountNumber,
      ifscCode: input.ifscCode,
      paypalEmail: input.paypalEmail,
      paytmNumber: input.paytmNumber,
    }
    const masked = maskPaymentDetails(plain)

    // The row's own id is part of the encryption AAD (see
    // lib/payment-encryption.ts), so it has to exist before the ciphertext
    // can be produced — an extra round trip on first save only; every save
    // after that finds the existing row instead of creating one.
    const existing = await prisma.paymentAccount.findUnique({
      where: { userId },
      select: { id: true },
    })
    const id =
      existing?.id ??
      (
        await prisma.paymentAccount.create({
          data: {
            userId,
            country: input.country,
            paymentType: input.paymentType,
            secureDetails: Buffer.alloc(0), // placeholder, overwritten below
          },
          select: { id: true },
        })
      ).id

    const secureDetails = encryptPaymentDetails(plain, `${id}:${userId}`)

    const row = await prisma.paymentAccount.update({
      where: { id },
      data: {
        country: input.country,
        paymentType: input.paymentType,
        bankName: input.bankName ?? null,
        branchName: input.branchName ?? null,
        // Prisma's generated `Bytes` field type wants `Uint8Array<ArrayBuffer>`;
        // `Buffer` is generic over the wider `ArrayBufferLike` (it also allows
        // a `SharedArrayBuffer` backing store), so newer TypeScript treats the
        // two as structurally incompatible despite `Buffer` being a `Uint8Array`
        // at runtime. Re-wrapping copies the bytes into a plain `Uint8Array`
        // backed by a real `ArrayBuffer`, satisfying the stricter type.
        secureDetails: new Uint8Array(secureDetails),
        ...masked,
      },
      select: maskedSelect,
    })

    await recordAudit({
      req,
      action: existing ? 'payment_account.updated' : 'payment_account.created',
      entityType: 'PaymentAccount',
      entityId: row.id,
      after: { country: row.country, paymentType: row.paymentType },
    })

    res.json({ data: row })
  },
)

// ─── Admin ────────────────────────────────────────────────────────────────────

const listQuery = z.object({ userId: z.string().cuid() })

/**
 * Masked, read-scoped the same as the rest of a tester's profile —
 * `tester.read` is what already gates seeing a tester's devices, skills and
 * work history, so bank details being visible-but-masked at that same level
 * is consistent rather than a stricter or looser carve-out.
 */
paymentAccountsRouter.get(
  '/',
  requirePermission(PERMISSIONS.TESTER_READ),
  validate({ query: listQuery }),
  async (_req, res) => {
    const { userId } = validatedQuery<z.infer<typeof listQuery>>(res)
    const row = await prisma.paymentAccount.findUnique({ where: { userId }, select: maskedSelect })
    res.json({ data: row })
  },
)

const revealBody = z.object({ password: z.string().min(1) })
const idParam = z.object({ id: z.string().cuid() })

/**
 * Step-up: the caller re-enters THEIR OWN password (not the tester's) to
 * prove the request is really them and not a hijacked session — the same
 * shape as `POST /auth/change-password`'s `currentPassword` check, reused
 * here as the smallest reasonable re-auth rather than a new session
 * mechanism. Nothing about this step is persisted; it is checked once, on
 * this request, and forgotten.
 */
paymentAccountsRouter.post(
  '/:id/reveal',
  requirePermission(PERMISSIONS.PAYMENT_ACCOUNT_DECRYPT),
  paymentRevealLimiter,
  validate({ params: idParam, body: revealBody }),
  async (req, res) => {
    const caller = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { passwordHash: true },
    })
    if (!caller?.passwordHash) {
      throw new BadRequestError('Your account has no password set and cannot use this action')
    }
    const { password } = req.body as z.infer<typeof revealBody>
    const valid = await verifyPassword(caller.passwordHash, password)
    if (!valid) throw new UnauthorizedError('Incorrect password')

    const id = param(req, 'id')
    const account = await prisma.paymentAccount.findUnique({ where: { id }, select: { id: true } })
    if (!account) throw new NotFoundError('Payment account')

    const plain = await revealPaymentAccount(id)

    // Names which fields were revealed — never their values. See the
    // module comment on `recordAudit` for why this never blocks the response.
    await recordAudit({
      req,
      action: 'payment_account.decrypted',
      entityType: 'PaymentAccount',
      entityId: id,
      after: { fieldsRevealed: Object.keys(plain).filter((k) => plain[k as keyof typeof plain]) },
    })

    res.json({ data: plain })
  },
)

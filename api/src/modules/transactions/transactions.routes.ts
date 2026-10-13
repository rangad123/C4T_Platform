import { Router } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { TransactionType, PaymentMethod, Role, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, isAdminSide, hasPermission } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { buildMeta, buildOrderBy, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { NotFoundError, BadRequestError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { nextReference } from '../../lib/reference.js'
import { createNotification } from '../notifications/notifications.service.js'
import { PERMISSIONS } from '../../config/permissions.js'
import { transactionScope } from '../../lib/access/scopes.js'
import { assertEmailVerified } from '../../lib/access/verification.js'

/**
 * §2.2 "Transactions" — payment and billing RECORDS for projects, Customers and
 * Testers, and §2.4 "View transaction/billing history".
 *
 * SCOPE NOTE: §5 excludes payment-gateway integration unless separately scoped.
 * Nothing here moves money. These are bookkeeping rows an Admin records, and
 * the portals read. If a gateway is added later it should write into this same
 * table via a new service, not replace it.
 *
 * Amounts are stored in MINOR UNITS (paise) as BigInt. Never use a float for
 * money. The API accepts and returns minor units; formatting is the frontend's job.
 *
 * A row has no status — its TYPE says what it is. TESTER_EARNING is a credit
 * (owed to the tester, in their wallet as soon as it is recorded) and
 * TESTER_PAYOUT is a debit (already paid). A tester asking to be paid is a
 * `PayoutRequest`, which reserves balance but is not a ledger row.
 */
export const transactionsRouter = Router()

transactionsRouter.use(authenticate)

const txSelect = {
  id: true,
  reference: true,
  type: true,
  amountMinor: true,
  currency: true,
  description: true,
  externalRef: true,
  occurredAt: true,
  createdAt: true,
  paymentMethod: true,
  tdsAmountMinor: true,
  paidAmountMinor: true,
  buildOrContestRef: true,
  organisation: { select: { id: true, name: true } },
  project: { select: { id: true, reference: true, title: true } },
  /// What the money was for, when it was for a build.
  build: { select: { id: true, name: true } },
  counterparty: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      // The admin counterparty link needs this to reach a tester's own
      // Payment details tab (`/admin/testers/:id` is keyed by TesterProfile
      // id, not User id — see `testers.service.ts getTesterById`).
      testerProfile: { select: { id: true } },
    },
  },
  recordedBy: { select: { id: true, firstName: true, lastName: true } },
  // Masked — never `include`, never `secureDetails`. Same select used by
  // `payment-accounts.routes.ts`'s own masked reads; a transaction read must
  // never be able to carry the linked account's ciphertext.
  paymentAccount: {
    select: {
      id: true,
      paymentType: true,
      bankName: true,
      accountNumberLast4: true,
      paypalEmailMasked: true,
      paytmNumberLast4: true,
    },
  },
} satisfies Prisma.TransactionSelect

/**
 * Shapes one transaction for the caller: removes the counterparty's email
 * address for anyone who is not admin-side.
 *
 * ── WHY THE EMAIL GOES
 *
 * A tester payout names the tester as the counterparty. A customer can
 * legitimately see their own ledger — including that a payout went to a named
 * tester — but the tester's email address is direct-contact PII with no
 * accounting purpose, and it let a client harvest addresses from the payments
 * list. The CSV export already only ever carried name and role; this brings
 * the JSON in line.
 *
 * `user` is a required parameter rather than an option so no call site can
 * quietly return an unmasked row by forgetting it.
 */
function maskCounterparty<T extends { counterparty?: { email: string } | null }>(
  user: Express.AuthenticatedUser,
  tx: T,
) {
  if (isAdminSide(user) || !tx.counterparty) return tx
  const { email: _omit, ...counterparty } = tx.counterparty
  return { ...tx, counterparty }
}

/**
 * Customers see transactions for their organisations; Testers see only rows
 * where they are the counterparty (their earnings and payouts).
 */
/** Delegates to the shared scope. */
const visibility = transactionScope

const TRANSACTION_SORT_FIELDS = [
  'occurredAt',
  'createdAt',
  'amountMinor',
  'type',
  'reference',
] as const

/**
 * §21-27 — Indian / International, as real backend queries over one table, not
 * client-side filters over one flat fetch. A row is bucketed by `paymentMethod`,
 * falling back to `currency` for rows recorded before a payment method was
 * attached to the ledger (see §Phase-C migration note).
 *
 * "Pending payments" is deliberately NOT a category of ledger rows any more:
 * what is still owed is a per-tester balance (`GET /owed`), because an earning
 * row never says whether it has since been paid out.
 */
const INDIAN_METHODS: PaymentMethod[] = [PaymentMethod.IND_BANK_ACCOUNT, PaymentMethod.PAYTM]
const INTERNATIONAL_METHODS: PaymentMethod[] = [
  PaymentMethod.NON_IND_BANK_ACCOUNT,
  PaymentMethod.PAYPAL,
]

export const TRANSACTION_CATEGORIES = ['indian', 'international'] as const
export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number]

/** Exported for reuse by `stats.routes.ts`'s dashboard payout breakdown — one categorisation, not two. */
export function categoryFilter(category?: TransactionCategory): Prisma.TransactionWhereInput {
  if (category === 'indian') {
    return {
      OR: [{ paymentMethod: { in: INDIAN_METHODS } }, { paymentMethod: null, currency: 'INR' }],
    }
  }
  if (category === 'international') {
    return {
      OR: [
        { paymentMethod: { in: INTERNATIONAL_METHODS } },
        { paymentMethod: null, NOT: { currency: 'INR' } },
      ],
    }
  }
  return {}
}

/** `financeYear=2025` → 1 Apr 2025 – 31 Mar 2026, India's financial year. */
function financeYearRange(financeYear?: number): Prisma.TransactionWhereInput {
  if (!financeYear) return {}
  return {
    occurredAt: {
      gte: new Date(Date.UTC(financeYear, 3, 1)),
      lt: new Date(Date.UTC(financeYear + 1, 3, 1)),
    },
  }
}

/** `month="2026-03"` → that calendar month, UTC. */
function monthRange(month?: string): Prisma.TransactionWhereInput {
  if (!month) return {}
  const [year, mon] = month.split('-').map(Number)
  if (!year || !mon) return {}
  return {
    occurredAt: {
      gte: new Date(Date.UTC(year, mon - 1, 1)),
      lt: new Date(Date.UTC(year, mon, 1)),
    },
  }
}

const transactionTypeEnum = z.nativeEnum(TransactionType)

const listQuery = paginationQuery.extend({
  /**
   * Comma-separated, so a caller can scope to several types at once (the
   * admin Transactions UI floors every request to the tester-payout types —
   * see `web/src/app/app/admin/transactions/page.tsx` — without forcing a
   * single-value choice). A bare `type=X` still works exactly as before.
   */
  type: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined
      const values = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const parsed = values.map((value) => {
        const result = transactionTypeEnum.safeParse(value)
        if (!result.success) {
          ctx.addIssue({ code: 'custom', message: `Invalid type: ${value}` })
          return z.NEVER
        }
        return result.data
      })
      return parsed.length > 0 ? parsed : undefined
    }),
  organisationId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  /** "Everything paid out on this build" — the query buildId exists for. */
  buildId: z.string().cuid().optional(),
  counterpartyId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  category: z.enum(TRANSACTION_CATEGORIES).optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  /** India's financial year by its starting calendar year, e.g. 2025 = FY2025-26. */
  financeYear: z.coerce.number().int().min(2000).max(2100).optional(),
  /** `YYYY-MM`. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM')
    .optional(),
})

/** Shared where-builder so the list and export endpoints never drift apart. */
function transactionWhere(
  user: Express.AuthenticatedUser,
  query: z.infer<typeof listQuery>,
): Prisma.TransactionWhereInput {
  const base: Prisma.TransactionWhereInput = {
    ...transactionScope(user),
    ...(query.type ? { type: { in: query.type } } : {}),
    ...(query.organisationId ? { organisationId: query.organisationId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.buildId ? { buildId: query.buildId } : {}),
    ...(query.counterpartyId ? { counterpartyId: query.counterpartyId } : {}),
    ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
    ...(query.from || query.to
      ? {
          occurredAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  }

  // `category` and `financeYear`/`month` both potentially set keys (`OR`,
  // `occurredAt`) that `base` may already set too — composed as separate AND
  // branches instead of spread into `base` so neither can silently overwrite
  // the other's key.
  const extra = [
    categoryFilter(query.category),
    financeYearRange(query.financeYear),
    monthRange(query.month),
  ].filter((clause) => Object.keys(clause).length > 0)

  return extra.length > 0 ? { AND: [base, ...extra] } : base
}

transactionsRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const query = validatedQuery<z.infer<typeof listQuery>>(res)
  const where = transactionWhere(req.user!, query)

  const [items, total, totals] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: txSelect,
      orderBy: buildOrderBy(query.sort, query.order, TRANSACTION_SORT_FIELDS, 'occurredAt'),
      ...toSkipTake(query),
    }),
    prisma.transaction.count({ where }),
    // Grouped by currency as well as type — summing amountMinor across rows
    // in different currencies (cents and paise are not the same unit) would
    // produce a number that isn't a real amount in any currency, however
    // confidently it gets a single symbol slapped on it afterward.
    prisma.transaction.groupBy({ by: ['type', 'currency'], where, _sum: { amountMinor: true } }),
  ])

  res.json({
    data: items.map((tx) => maskCounterparty(req.user!, tx)),
    meta: {
      ...buildMeta(query, total),
      totalsByType: totals.map((t) => ({
        type: t.type,
        currency: t.currency,
        amountMinor: (t._sum.amountMinor ?? 0n).toString(),
      })),
    },
  })
})

const owedQuery = paginationQuery.extend({
  /** Matches the tester's name. */
  search: z.string().trim().max(120).optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
})

/**
 * §27 Pending Payments — who is owed what, as one row per tester and currency.
 *
 * Owed = every credit recorded for them minus every payout recorded to them.
 * A tester with an open payout request is listed even if the sums say they are
 * square, so a request can never sit where nobody can see it. Declared before
 * `/:id`, or "owed" would be read as a transaction id.
 */
transactionsRouter.get(
  '/owed',
  requirePermission(PERMISSIONS.TRANSACTION_READ),
  validate({ query: owedQuery }),
  async (req, res) => {
    const query = validatedQuery<z.infer<typeof owedQuery>>(res)

    const [balances, requests] = await Promise.all([
      testerBalances(),
      prisma.payoutRequest.findMany({
        where: { fulfilledAt: null },
        select: { id: true, testerId: true, amountMinor: true, currency: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    interface Row {
      testerId: string
      currency: string
      owedMinor: bigint
      lastCreditAt: Date | null
      openRequest: { id: string; amountMinor: bigint; createdAt: Date } | null
    }
    const rows = new Map<string, Row>()
    const key = (testerId: string, currency: string) => `${testerId}|${currency}`
    for (const b of balances) {
      const owedMinor = b.creditedMinor - b.paidOutMinor
      if (owedMinor > 0n) {
        rows.set(key(b.testerId, b.currency), {
          testerId: b.testerId,
          currency: b.currency,
          owedMinor,
          lastCreditAt: b.lastCreditAt,
          openRequest: null,
        })
      }
    }
    for (const r of requests) {
      const existing = rows.get(key(r.testerId, r.currency))
      const openRequest = { id: r.id, amountMinor: r.amountMinor, createdAt: r.createdAt }
      if (existing) existing.openRequest ??= openRequest
      else {
        rows.set(key(r.testerId, r.currency), {
          testerId: r.testerId,
          currency: r.currency,
          owedMinor: 0n,
          lastCreditAt: null,
          openRequest,
        })
      }
    }

    const testers = await prisma.user.findMany({
      where: {
        id: { in: [...new Set([...rows.values()].map((r) => r.testerId))] },
        deletedAt: null,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        testerProfile: { select: { id: true, countryCode: true } },
        // Masked columns only — never `secureDetails`.
        paymentAccount: {
          select: {
            paymentType: true,
            bankName: true,
            accountNumberLast4: true,
            paypalEmailMasked: true,
            paytmNumberLast4: true,
          },
        },
      },
    })
    const byId = new Map(testers.map((t) => [t.id, t]))
    const terms = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)

    const items = [...rows.values()]
      .flatMap((r) => {
        const tester = byId.get(r.testerId)
        if (!tester) return []
        if (query.paymentMethod && tester.paymentAccount?.paymentType !== query.paymentMethod) {
          return []
        }
        const name = `${tester.firstName ?? ''} ${tester.lastName ?? ''}`.toLowerCase()
        if (!terms.every((term) => name.includes(term))) return []
        return [
          {
            testerId: tester.id,
            testerProfileId: tester.testerProfile?.id ?? null,
            firstName: tester.firstName,
            lastName: tester.lastName,
            countryCode: tester.testerProfile?.countryCode ?? null,
            currency: r.currency,
            owedMinor: r.owedMinor.toString(),
            lastCreditAt: r.lastCreditAt,
            paymentAccount: tester.paymentAccount,
            openRequest: r.openRequest
              ? { ...r.openRequest, amountMinor: r.openRequest.amountMinor.toString() }
              : null,
          },
        ]
      })
      // A request first, then the most recently credited — newest work leads.
      .sort(
        (a, b) =>
          Number(Boolean(b.openRequest)) - Number(Boolean(a.openRequest)) ||
          (b.lastCreditAt?.getTime() ?? 0) - (a.lastCreditAt?.getTime() ?? 0),
      )

    const { skip, take } = toSkipTake(query)
    res.json({ data: items.slice(skip, skip + take), meta: buildMeta(query, items.length) })
  },
)

transactionsRouter.get(
  '/:id',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const tx = await prisma.transaction.findFirst({
      where: { id: param(req, 'id'), ...visibility(req.user!) },
      select: txSelect,
    })
    if (!tx) throw new NotFoundError('Transaction')
    res.json({ data: maskCounterparty(req.user!, tx) })
  },
)

const createSchema = z.object({
  type: z.nativeEnum(TransactionType),
  /** Minor units. 150000 = ₹1,500.00 */
  amountMinor: z.coerce.bigint().positive('Amount must be greater than zero'),
  currency: z.string().trim().length(3).toUpperCase().default('INR'),
  organisationId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  /** The build this money is for, when it is for one. */
  buildId: z.string().cuid().optional(),
  counterpartyId: z.string().cuid().optional(),
  description: z.string().trim().max(1000).optional(),
  externalRef: z.string().trim().max(120).optional(),
  occurredAt: z.coerce.date().default(() => new Date()),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  paymentAccountId: z.string().cuid().optional(),
  /** Minor units, like `amountMinor`. */
  tdsAmountMinor: z.coerce.bigint().nonnegative().optional(),
  /** What actually reached the tester, after TDS. Defaults to amount − TDS for a payout. */
  paidAmountMinor: z.coerce.bigint().nonnegative().optional(),
  buildOrContestRef: z.string().trim().max(160).optional(),
  /** The open request this payout settles — closes it in the same step. */
  payoutRequestId: z.string().cuid().optional(),
})

const CUSTOMER_TYPES: TransactionType[] = [
  TransactionType.CUSTOMER_INVOICE,
  TransactionType.CUSTOMER_PAYMENT,
  TransactionType.REFUND,
]
const TESTER_TYPES: TransactionType[] = [
  TransactionType.TESTER_EARNING,
  TransactionType.TESTER_PAYOUT,
]

transactionsRouter.post(
  '/',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ body: createSchema }),
  async (req, res) => {
    const { payoutRequestId, ...input } = req.body as z.infer<typeof createSchema>

    if (input.tdsAmountMinor !== undefined && input.tdsAmountMinor > input.amountMinor) {
      throw new BadRequestError('TDS cannot be more than the amount')
    }
    if (payoutRequestId) {
      if (input.type !== TransactionType.TESTER_PAYOUT) {
        throw new BadRequestError('Only a payout can settle a payout request')
      }
      const request = await prisma.payoutRequest.findFirst({
        where: { id: payoutRequestId, fulfilledAt: null },
        select: { testerId: true },
      })
      if (!request) throw new BadRequestError('That payout request is no longer open')
      if (request.testerId !== input.counterpartyId) {
        throw new BadRequestError('That payout request belongs to a different tester')
      }
    }

    // Keep the ledger coherent: a customer-side row needs an organisation, a
    // tester-side row needs a tester counterparty.
    if (CUSTOMER_TYPES.includes(input.type) && !input.organisationId) {
      throw new BadRequestError(`organisationId is required for a ${input.type} transaction`)
    }
    if (TESTER_TYPES.includes(input.type)) {
      if (!input.counterpartyId) {
        throw new BadRequestError(`counterpartyId is required for a ${input.type} transaction`)
      }
      const tester = await prisma.user.findFirst({
        where: { id: input.counterpartyId, role: Role.TESTER, deletedAt: null },
        select: { id: true },
      })
      if (!tester) throw new BadRequestError('The counterparty is not a tester account')
    }
    if (input.paymentAccountId) {
      const account = await prisma.paymentAccount.findFirst({
        where: {
          id: input.paymentAccountId,
          ...(input.counterpartyId ? { userId: input.counterpartyId } : {}),
        },
        select: { id: true },
      })
      if (!account)
        throw new BadRequestError('paymentAccountId does not belong to the counterparty')
    }
    /**
     * A build must belong to the project it is filed under, or the pairing
     * says something untrue: "paid for build X on project Y" when X was never
     * part of Y. Checked here rather than trusted, because both ids arrive
     * from the client — the payout links carry them in a query string.
     */
    if (input.buildId) {
      const build = await prisma.build.findFirst({
        where: {
          id: input.buildId,
          deletedAt: null,
          ...(input.projectId ? { projectId: input.projectId } : {}),
        },
        select: { projectId: true },
      })
      if (!build) {
        throw new BadRequestError(
          input.projectId
            ? 'That build does not belong to the given project'
            : 'That build does not exist',
        )
      }
      // Filing against a build implies its project, so fill it in rather than
      // leaving a row that knows the build but not what it belonged to.
      input.projectId ??= build.projectId
    }

    const reference = await nextReference('transaction')
    const paidAmountMinor =
      input.paidAmountMinor ??
      (input.type === TransactionType.TESTER_PAYOUT
        ? input.amountMinor - (input.tdsAmountMinor ?? 0n)
        : undefined)

    // The row and the request it settles land together or not at all — a
    // payout that is recorded but leaves its request open would keep reserving
    // balance the tester has already been paid.
    const tx = await prisma.$transaction(async (db) => {
      const created = await db.transaction.create({
        data: { ...input, paidAmountMinor, reference, recordedById: req.user!.id },
        select: txSelect,
      })
      if (payoutRequestId) {
        const closed = await db.payoutRequest.updateMany({
          where: { id: payoutRequestId, fulfilledAt: null },
          data: { fulfilledAt: new Date(), fulfilledByTransactionId: created.id },
        })
        if (closed.count !== 1) throw new BadRequestError('That payout request is no longer open')
      }
      return created
    })

    if (input.counterpartyId) {
      const title =
        input.type === TransactionType.TESTER_PAYOUT
          ? `A payout has been recorded: ${tx.reference}`
          : input.type === TransactionType.TESTER_EARNING
            ? `New earning credited: ${tx.reference}`
            : `New transaction recorded: ${tx.reference}`
      await createNotification({
        userId: input.counterpartyId,
        type: 'TRANSACTION_UPDATED',
        title,
        link: '/app/transactions',
      })
    }

    await recordAudit({
      req,
      action: 'transaction.created',
      entityType: 'Transaction',
      entityId: tx.id,
      after: {
        reference: tx.reference,
        type: tx.type,
        amountMinor: tx.amountMinor.toString(),
        ...(payoutRequestId ? { payoutRequestId } : {}),
      },
    })

    res.status(201).json({ data: maskCounterparty(req.user!, tx) })
  },
)

const updateSchema = z.object({
  description: z.string().trim().max(1000).optional(),
  externalRef: z.string().trim().max(120).optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  paymentAccountId: z.string().cuid().optional(),
  /** What actually reached the tester, after TDS. */
  paidAmountMinor: z.coerce.bigint().nonnegative().optional(),
  tdsAmountMinor: z.coerce.bigint().nonnegative().optional(),
  buildOrContestRef: z.string().trim().max(160).optional(),
})

transactionsRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ params: z.object({ id: z.string().cuid() }), body: updateSchema }),
  async (req, res) => {
    const input = req.body as z.infer<typeof updateSchema>

    const existing = await prisma.transaction.findUnique({
      where: { id: param(req, 'id') },
      select: { id: true, amountMinor: true, tdsAmountMinor: true },
    })
    if (!existing) throw new NotFoundError('Transaction')

    const tds = input.tdsAmountMinor ?? existing.tdsAmountMinor
    if (tds !== null && tds !== undefined && tds > existing.amountMinor) {
      throw new BadRequestError('TDS cannot be more than the amount')
    }

    const tx = await prisma.transaction.update({
      where: { id: param(req, 'id') },
      data: input,
      select: txSelect,
    })

    await recordAudit({
      req,
      action: 'transaction.updated',
      entityType: 'Transaction',
      entityId: tx.id,
      after: input,
    })

    res.json({ data: maskCounterparty(req.user!, tx) })
  },
)

/**
 * The smallest payout a tester may ask for, in minor units. ₹500.00.
 *
 * A floor exists because settling a payout costs the same in effort whatever
 * the amount, and a queue of ₹20 requests helps nobody. Exported so the
 * frontend can state the threshold rather than discovering it by being
 * rejected.
 */
export const PAYOUT_MINIMUM_MINOR = 50_000n

/** An open request is one nobody has paid yet. Shared by every read and write so they agree. */
const OPEN_REQUEST = { fulfilledAt: null } as const

/** INR for an Indian payout instrument, USD for everything else — the same split `categoryFilter` buckets settled transactions by. */
function currencyForPaymentType(type: PaymentMethod): 'INR' | 'USD' {
  return INDIAN_METHODS.includes(type) ? 'INR' : 'USD'
}

/**
 * The currency a tester is actually paid in, derived from their current
 * payout instrument. Falls back to INR when no payment account exists yet —
 * nothing to derive from, and a payout is blocked in that state regardless.
 *
 * Every tester-facing balance read used to hardcode `currency: 'INR'`
 * instead of this, so an international tester (PayPal / a non-Indian bank
 * account) saw their own earnings and payout totals labelled in INR even
 * though the underlying amounts were never rupees.
 */
async function testerCurrency(testerId: string): Promise<'INR' | 'USD'> {
  const account = await prisma.paymentAccount.findFirst({
    where: { userId: testerId, status: 'ACTIVE' },
    select: { paymentType: true },
  })
  return account ? currencyForPaymentType(account.paymentType) : 'INR'
}

/**
 * Credits and debits per tester and currency, across the whole ledger.
 *
 * Exported for the dashboard (`stats.routes.ts`) so "still owed" there and on
 * the Pending payments tab are computed once, the same way — per tester, never
 * as one global earnings-minus-payouts figure, which would let one tester's
 * overpayment quietly cancel another's balance.
 */
export interface TesterBalance {
  testerId: string
  currency: string
  creditedMinor: bigint
  paidOutMinor: bigint
  /** When the most recent credit was earned — what the Pending payments list is ordered by. */
  lastCreditAt: Date | null
}

export async function testerBalances(): Promise<TesterBalance[]> {
  const grouped = await prisma.transaction.groupBy({
    by: ['counterpartyId', 'currency', 'type'],
    where: {
      type: { in: [TransactionType.TESTER_EARNING, TransactionType.TESTER_PAYOUT] },
      counterpartyId: { not: null },
    },
    _sum: { amountMinor: true },
    _max: { occurredAt: true },
  })
  const balances = new Map<string, TesterBalance>()
  for (const g of grouped) {
    if (!g.counterpartyId) continue
    const key = `${g.counterpartyId}|${g.currency}`
    const row = balances.get(key) ?? {
      testerId: g.counterpartyId,
      currency: g.currency,
      creditedMinor: 0n,
      paidOutMinor: 0n,
      lastCreditAt: null,
    }
    const sum = g._sum.amountMinor ?? 0n
    if (g.type === TransactionType.TESTER_EARNING) {
      row.creditedMinor += sum
      row.lastCreditAt = g._max.occurredAt
    } else row.paidOutMinor += sum
    balances.set(key, row)
  }
  return [...balances.values()]
}

/** What each tester is owed, per currency — a tester paid up to or past their credits owes nothing. */
export async function owedByCurrency(): Promise<{ currency: string; amountMinor: string }[]> {
  const totals = new Map<string, bigint>()
  for (const b of await testerBalances()) {
    const owed = b.creditedMinor - b.paidOutMinor
    if (owed > 0n) totals.set(b.currency, (totals.get(b.currency) ?? 0n) + owed)
  }
  return [...totals].map(([currency, amount]) => ({ currency, amountMinor: amount.toString() }))
}

/**
 * The tester's money. A ledger row carries no status — its type says it all:
 *
 *   credited     every TESTER_EARNING — in the wallet the moment it is recorded
 *   paid out     what actually reached the tester: every TESTER_PAYOUT, minus
 *                the TDS withheld from it
 *   TDS deducted the withheld tax. It is paid to the government on the
 *                tester's behalf, so it is NOT owed to the tester any more —
 *                it leaves the wallet exactly like a payout does
 *   requested    open payout requests — not sent yet, but reserved so the same
 *                balance cannot be asked for twice
 *   available    credited − paid out − TDS deducted − requested
 *
 * A payout's `amountMinor` is the whole amount that left the wallet, and its
 * `tdsAmountMinor` is the part of that which went to the government. A TDS
 * entry on its own (a legacy `tds_history` row) is a payout whose amount IS
 * its TDS, so it deducts the tax and pays the tester nothing.
 */
async function payoutBalance(testerId: string): Promise<{
  /** Credited, minus paid out, TDS and requests. What may be withdrawn now. */
  availableMinor: bigint
  /** Every TESTER_EARNING. */
  creditedMinor: bigint
  /** What reached the tester — payouts net of TDS. */
  paidOutMinor: bigint
  /** Tax withheld from payouts and paid to the government. */
  tdsDeductedMinor: bigint
  /** Open payout requests — not yet sent, still reserved against the balance. */
  requestedMinor: bigint
}> {
  const [credited, paidOut, requested] = await Promise.all([
    prisma.transaction.aggregate({
      where: { counterpartyId: testerId, type: TransactionType.TESTER_EARNING },
      _sum: { amountMinor: true },
    }),
    prisma.transaction.aggregate({
      where: { counterpartyId: testerId, type: TransactionType.TESTER_PAYOUT },
      _sum: { amountMinor: true, tdsAmountMinor: true },
    }),
    prisma.payoutRequest.aggregate({
      where: { testerId, ...OPEN_REQUEST },
      _sum: { amountMinor: true },
    }),
  ])

  const creditedMinor = credited._sum.amountMinor ?? 0n
  const leftWalletMinor = paidOut._sum.amountMinor ?? 0n
  const tdsDeductedMinor = paidOut._sum.tdsAmountMinor ?? 0n
  const requestedMinor = requested._sum.amountMinor ?? 0n
  const paidOutMinor = leftWalletMinor - tdsDeductedMinor
  const availableMinor = creditedMinor - leftWalletMinor - requestedMinor

  return {
    creditedMinor,
    paidOutMinor: paidOutMinor > 0n ? paidOutMinor : 0n,
    tdsDeductedMinor,
    requestedMinor,
    availableMinor: availableMinor > 0n ? availableMinor : 0n,
  }
}

/**
 * §2.3 — what the tester can request right now, and whether they can.
 *
 * Returns the reasons as flags rather than prose so the frontend owns the
 * wording. `canRequest` is the single answer the button should key off; the
 * individual flags explain it.
 */
transactionsRouter.get('/payouts/mine', async (req, res) => {
  if (req.user!.role !== Role.TESTER)
    throw new BadRequestError('Only a tester has a payout balance')

  const [balance, account, openRequest, requester] = await Promise.all([
    payoutBalance(req.user!.id),
    prisma.paymentAccount.findFirst({
      where: { userId: req.user!.id, status: 'ACTIVE' },
      select: { id: true, paymentType: true },
    }),
    prisma.payoutRequest.findFirst({
      where: { testerId: req.user!.id, ...OPEN_REQUEST },
      select: { id: true, amountMinor: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.findUnique({ where: { id: req.user!.id }, select: { emailVerifiedAt: true } }),
  ])

  const meetsMinimum = balance.availableMinor >= PAYOUT_MINIMUM_MINOR
  const emailVerified = Boolean(requester?.emailVerifiedAt)

  res.json({
    data: {
      currency: account ? currencyForPaymentType(account.paymentType) : 'INR',
      availableMinor: balance.availableMinor.toString(),
      /** Every earning, credited the moment it's recorded — legacy "Credit Fund". */
      creditedMinor: balance.creditedMinor.toString(),
      paidOutMinor: balance.paidOutMinor.toString(),
      tdsDeductedMinor: balance.tdsDeductedMinor.toString(),
      /** Open payout requests — not yet sent, still reserved against the balance. */
      requestedMinor: balance.requestedMinor.toString(),
      minimumMinor: PAYOUT_MINIMUM_MINOR.toString(),
      hasPaymentAccount: Boolean(account),
      meetsMinimum,
      emailVerified,
      openRequest: openRequest
        ? { ...openRequest, amountMinor: openRequest.amountMinor.toString() }
        : null,
      canRequest: Boolean(account) && meetsMinimum && !openRequest && emailVerified,
    },
  })
})

/**
 * §23 "Account details" — an admin's view of a tester's current wallet
 * balance. Same shape and the same `payoutBalance()` as the tester's own
 * `/payouts/mine` above, just admin-targeted: gated by `transaction.read`
 * rather than "is this your own balance", and keyed by a path param instead
 * of the session. Declared after the literal `/payouts/mine` route, not
 * before — Express matches in declaration order, and a `/payouts/:testerId`
 * route declared first would swallow "mine" as a (invalid) testerId.
 */
transactionsRouter.get(
  '/payouts/:testerId',
  requirePermission(PERMISSIONS.TRANSACTION_READ),
  validate({ params: z.object({ testerId: z.string().cuid() }) }),
  async (req, res) => {
    const testerId = param(req, 'testerId')
    const tester = await prisma.user.findFirst({
      where: { id: testerId, role: Role.TESTER, deletedAt: null },
      select: { id: true },
    })
    if (!tester) throw new NotFoundError('Tester')

    const [balance, account] = await Promise.all([
      payoutBalance(testerId),
      prisma.paymentAccount.findFirst({
        where: { userId: testerId, status: 'ACTIVE' },
        select: { paymentType: true },
      }),
    ])

    res.json({
      data: {
        currency: account ? currencyForPaymentType(account.paymentType) : 'INR',
        availableMinor: balance.availableMinor.toString(),
        creditedMinor: balance.creditedMinor.toString(),
        paidOutMinor: balance.paidOutMinor.toString(),
        tdsDeductedMinor: balance.tdsDeductedMinor.toString(),
        requestedMinor: balance.requestedMinor.toString(),
      },
    })
  },
)

const requestPayoutSchema = z.object({
  /**
   * Minor units. Omit to request the whole available balance — the common
   * case, and the one that cannot go stale between reading the page and
   * submitting it.
   */
  amountMinor: z.coerce.bigint().positive().optional(),
  note: z.string().trim().max(500).optional(),
})

/**
 * §2.3 — a tester asks to be paid.
 *
 * Creates a `PayoutRequest`, NOT a ledger row: nothing has been paid, so the
 * wallet's paid-out figure must not move. The request only reserves the amount
 * until an admin pays it outside the platform and records the payout with this
 * request's id. The tester is the only one who can call this for themselves —
 * `testerId` comes from the session and is never read from the body, so a
 * tester cannot request a payout against someone else's balance.
 */
transactionsRouter.post(
  '/payouts/request',
  validate({ body: requestPayoutSchema }),
  async (req, res) => {
    if (req.user!.role !== Role.TESTER) {
      throw new BadRequestError('Only a tester can request a payout')
    }
    await assertEmailVerified(req.user!.id)
    const input = req.body as z.infer<typeof requestPayoutSchema>

    const account = await prisma.paymentAccount.findFirst({
      where: { userId: req.user!.id, status: 'ACTIVE' },
      select: { id: true, paymentType: true },
    })
    if (!account) {
      throw new BadRequestError('Add your payment details before requesting a payout')
    }

    // One open request at a time. Without this, two submits seconds apart both
    // pass the balance check and the ledger owes twice what it should.
    const openRequest = await prisma.payoutRequest.findFirst({
      where: { testerId: req.user!.id, ...OPEN_REQUEST },
      select: { id: true },
    })
    if (openRequest) {
      throw new BadRequestError('You already have a payout request in progress')
    }

    const balance = await payoutBalance(req.user!.id)
    const amountMinor = input.amountMinor ?? balance.availableMinor

    if (amountMinor > balance.availableMinor) {
      throw new BadRequestError('That is more than your available balance')
    }
    if (amountMinor < PAYOUT_MINIMUM_MINOR) {
      throw new BadRequestError('That is below the minimum payout amount')
    }

    const request = await prisma.payoutRequest.create({
      data: {
        testerId: req.user!.id,
        amountMinor,
        currency: currencyForPaymentType(account.paymentType),
        paymentAccountId: account.id,
        note: input.note,
      },
      select: { id: true, amountMinor: true, currency: true, createdAt: true },
    })

    await recordAudit({
      req,
      action: 'transaction.payout_requested',
      entityType: 'PayoutRequest',
      entityId: request.id,
      after: { amountMinor: request.amountMinor.toString(), currency: request.currency },
    })

    res.status(201).json({ data: { ...request, amountMinor: request.amountMinor.toString() } })
  },
)

/**
 * Cancel an open payout request — the tester's own, or any tester's for an
 * admin who may write transactions.
 *
 * Without this a request nobody wants paid would reserve the balance and block
 * the tester from asking again, with no way out. A request that has already
 * been paid is closed, not open, so it cannot be cancelled. Anyone else gets a
 * 404 rather than a 403: the response must not confirm the request exists.
 */
transactionsRouter.delete(
  '/payouts/requests/:id',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const request = await prisma.payoutRequest.findFirst({
      where: { id: param(req, 'id'), ...OPEN_REQUEST },
      select: { id: true, testerId: true, amountMinor: true, currency: true },
    })
    const mayCancel =
      request &&
      (request.testerId === req.user!.id || hasPermission(req.user!, PERMISSIONS.TRANSACTION_WRITE))
    if (!request || !mayCancel) throw new NotFoundError('Payout request')

    // Re-checked in the delete itself: an admin paying it at this very moment
    // must win, not have their just-recorded payout's request vanish.
    const removed = await prisma.payoutRequest.deleteMany({
      where: { id: request.id, ...OPEN_REQUEST },
    })
    if (removed.count !== 1) throw new NotFoundError('Payout request')

    await recordAudit({
      req,
      action: 'transaction.payout_request_cancelled',
      entityType: 'PayoutRequest',
      entityId: request.id,
      before: { amountMinor: request.amountMinor.toString(), currency: request.currency },
    })

    if (request.testerId !== req.user!.id) {
      await createNotification({
        userId: request.testerId,
        type: 'TRANSACTION_UPDATED',
        title: 'Your payout request was cancelled',
        link: '/app/tester',
      })
    }

    res.status(204).end()
  },
)

/** §2.3 — a tester's own earnings summary. */
transactionsRouter.get('/summary/mine', async (req, res) => {
  // The wallet's own figures, so "paid out" and "TDS deducted" mean the same
  // thing here as they do on the wallet — one definition, not two.
  const [balance, currency] = await Promise.all([
    payoutBalance(req.user!.id),
    testerCurrency(req.user!.id),
  ])

  res.json({
    data: {
      currency,
      earnedTotalMinor: balance.creditedMinor.toString(),
      paidOutMinor: balance.paidOutMinor.toString(),
      tdsDeductedMinor: balance.tdsDeductedMinor.toString(),
    },
  })
})

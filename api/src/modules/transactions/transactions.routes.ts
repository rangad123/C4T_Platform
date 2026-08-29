import { Router } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { TransactionType, TransactionStatus, PaymentMethod, Role, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, isAdminSide } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { buildMeta, buildOrderBy, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { NotFoundError, BadRequestError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { nextReference } from '../../lib/reference.js'
import { createNotification } from '../notifications/notifications.service.js'
import { PERMISSIONS } from '../../config/permissions.js'
import { transactionScope } from '../../lib/access/scopes.js'
import { timestampedFilename } from '../../lib/csv.js'

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
 */
export const transactionsRouter = Router()

transactionsRouter.use(authenticate)

const txSelect = {
  id: true,
  reference: true,
  type: true,
  status: true,
  amountMinor: true,
  currency: true,
  description: true,
  externalRef: true,
  occurredAt: true,
  settledAt: true,
  createdAt: true,
  paymentMethod: true,
  tdsAmountMinor: true,
  paidAmountMinor: true,
  buildOrContestRef: true,
  organisation: { select: { id: true, name: true } },
  project: { select: { id: true, reference: true, title: true } },
  counterparty: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
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
 * Shapes one transaction for the caller: adds the computed outstanding amount,
 * and removes the counterparty's email address for anyone who is not
 * admin-side.
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
function withOutstanding<
  T extends {
    amountMinor: bigint
    paidAmountMinor: bigint
    counterparty?: { email: string } | null
  },
>(user: Express.AuthenticatedUser, tx: T) {
  const outstandingMinor = (tx.amountMinor - tx.paidAmountMinor).toString()
  if (isAdminSide(user) || !tx.counterparty) return { ...tx, outstandingMinor }
  const { email: _omit, ...counterparty } = tx.counterparty
  return { ...tx, counterparty, outstandingMinor }
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
  'status',
  'reference',
] as const

/**
 * §21-27 — Indian / International / Pending, as three real backend queries
 * over one table, not three client-side filters over one flat fetch.
 *
 * Pending takes priority over the other two: any transaction still in
 * PENDING or APPROVED is "Pending Payments" regardless of what currency or
 * payment method it will eventually settle in — that is exactly what the
 * brief's "Outstanding Amount" framing for that category is about (money not
 * yet paid out). Only settled rows get bucketed as Indian/International, by
 * `paymentMethod`, falling back to `currency` for rows recorded before a
 * payment method was attached to the ledger (see §Phase-C migration note).
 */
/**
 * RELEASED belongs here with PENDING and APPROVED: the category means "money
 * not yet paid out", and releasing funds authorises a payment without making
 * one. Omitting it would push released-but-unpaid rows into the
 * Indian/International buckets, which are explicitly for settled rows only.
 */
const PENDING_STATUSES: TransactionStatus[] = [
  TransactionStatus.PENDING,
  TransactionStatus.APPROVED,
  TransactionStatus.RELEASED,
]
const INDIAN_METHODS: PaymentMethod[] = [PaymentMethod.IND_BANK_ACCOUNT, PaymentMethod.PAYTM]
const INTERNATIONAL_METHODS: PaymentMethod[] = [PaymentMethod.NON_IND_BANK_ACCOUNT, PaymentMethod.PAYPAL]

export const TRANSACTION_CATEGORIES = ['indian', 'international', 'pending'] as const
export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number]

/** Exported for reuse by `stats.routes.ts`'s dashboard payout breakdown — one categorisation, not two. */
export function categoryFilter(category?: TransactionCategory): Prisma.TransactionWhereInput {
  if (category === 'pending') return { status: { in: PENDING_STATUSES } }
  if (category === 'indian') {
    return {
      status: { notIn: PENDING_STATUSES },
      OR: [
        { paymentMethod: { in: INDIAN_METHODS } },
        { paymentMethod: null, currency: 'INR' },
      ],
    }
  }
  if (category === 'international') {
    return {
      status: { notIn: PENDING_STATUSES },
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
  status: z.nativeEnum(TransactionStatus).optional(),
  organisationId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
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
    ...(query.status ? { status: query.status } : {}),
    ...(query.organisationId ? { organisationId: query.organisationId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
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

  // `category` and `financeYear`/`month` both potentially set `status`/
  // `occurredAt`, which `base` may already set too — composed as separate AND
  // branches instead of spread into `base` so neither can silently overwrite
  // the other's key.
  const extra = [categoryFilter(query.category), financeYearRange(query.financeYear), monthRange(query.month)]
    .filter((clause) => Object.keys(clause).length > 0)

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
    prisma.transaction.groupBy({ by: ['type'], where, _sum: { amountMinor: true } }),
  ])

  res.json({
    data: items.map((tx) => withOutstanding(req.user!, tx)),
    meta: {
      ...buildMeta(query, total),
      totalsByType: totals.map((t) => ({
        type: t.type,
        amountMinor: (t._sum.amountMinor ?? 0n).toString(),
      })),
    },
  })
})

/**
 * CSV export — declared before "/:id" so "export.csv" is not consumed as an
 * id with a dot in it. Same filters/scope as the list endpoint, no pagination.
 */
transactionsRouter.get('/export.csv', validate({ query: listQuery }), async (req, res) => {
  const query = validatedQuery<z.infer<typeof listQuery>>(res)
  const where = transactionWhere(req.user!, query)

  const items = await prisma.transaction.findMany({
    where,
    select: txSelect,
    orderBy: buildOrderBy(query.sort, query.order, TRANSACTION_SORT_FIELDS, 'occurredAt'),
  })

  // BigInt minor units, converted to a plain decimal string for the
  // spreadsheet — Excel/Sheets read "150000" as 150000, not ₹1,500.00, so
  // divide by 100 here rather than exporting the raw minor-unit integer.
  const money = (minor: bigint) => (Number(minor) / 100).toFixed(2)

  const rows = items.map((t) => [
    t.reference,
    t.type,
    t.status,
    money(t.amountMinor),
    money(t.paidAmountMinor),
    money(t.amountMinor - t.paidAmountMinor),
    t.tdsAmountMinor !== null ? money(t.tdsAmountMinor) : '',
    t.currency,
    t.paymentMethod ?? '',
    t.description ?? '',
    t.organisation?.name ?? '',
    t.project?.reference ?? '',
    t.buildOrContestRef ?? '',
    [t.counterparty?.firstName, t.counterparty?.lastName].filter(Boolean).join(' '),
    t.counterparty?.role ?? '',
    t.occurredAt,
    t.settledAt,
    t.createdAt,
  ])

  const { toCsv } = await import('../../lib/csv.js')
  const csv = toCsv(
    [
      'Reference',
      'Type',
      'Status',
      'Amount',
      'Paid amount',
      'Outstanding amount',
      'TDS amount',
      'Currency',
      'Payment method',
      'Description',
      'Organisation',
      'Project',
      'Build/contest ref',
      'Counterparty',
      'Counterparty role',
      'Occurred at',
      'Settled at',
      'Created at',
    ],
    rows,
  )

  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${timestampedFilename('transactions')}"`)
  res.send(csv)
})

transactionsRouter.get(
  '/:id',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const tx = await prisma.transaction.findFirst({
      where: { id: param(req, 'id'), ...visibility(req.user!) },
      select: txSelect,
    })
    if (!tx) throw new NotFoundError('Transaction')
    res.json({ data: withOutstanding(req.user!, tx) })
  },
)

const createSchema = z.object({
  type: z.nativeEnum(TransactionType),
  status: z.nativeEnum(TransactionStatus).default(TransactionStatus.PENDING),
  /** Minor units. 150000 = ₹1,500.00 */
  amountMinor: z.coerce.bigint().positive('Amount must be greater than zero'),
  currency: z.string().trim().length(3).toUpperCase().default('INR'),
  organisationId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  counterpartyId: z.string().cuid().optional(),
  description: z.string().trim().max(1000).optional(),
  externalRef: z.string().trim().max(120).optional(),
  occurredAt: z.coerce.date().default(() => new Date()),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  paymentAccountId: z.string().cuid().optional(),
  /** Minor units, like `amountMinor`. */
  tdsAmountMinor: z.coerce.bigint().nonnegative().optional(),
  paidAmountMinor: z.coerce.bigint().nonnegative().optional(),
  buildOrContestRef: z.string().trim().max(160).optional(),
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
    const input = req.body as z.infer<typeof createSchema>

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
        where: { id: input.paymentAccountId, ...(input.counterpartyId ? { userId: input.counterpartyId } : {}) },
        select: { id: true },
      })
      if (!account) throw new BadRequestError('paymentAccountId does not belong to the counterparty')
    }

    const tx = await prisma.transaction.create({
      data: {
        ...input,
        reference: await nextReference('transaction'),
        recordedById: req.user!.id,
        ...(input.status === TransactionStatus.PAID ? { settledAt: new Date() } : {}),
      },
      select: txSelect,
    })

    if (input.counterpartyId) {
      await createNotification({
        userId: input.counterpartyId,
        type: 'TRANSACTION_UPDATED',
        title: `New transaction recorded: ${tx.reference}`,
        link: '/app/transactions',
      })
    }

    await recordAudit({
      req,
      action: 'transaction.created',
      entityType: 'Transaction',
      entityId: tx.id,
      after: { reference: tx.reference, type: tx.type, amountMinor: tx.amountMinor.toString() },
    })

    res.status(201).json({ data: withOutstanding(req.user!, tx) })
  },
)

const updateSchema = z.object({
  status: z.nativeEnum(TransactionStatus).optional(),
  description: z.string().trim().max(1000).optional(),
  externalRef: z.string().trim().max(120).optional(),
  settledAt: z.coerce.date().nullable().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  paymentAccountId: z.string().cuid().optional(),
  /** Records a (partial or full) payout against this transaction — Pending
   * Payments' whole reason to exist is tracking this moving toward
   * `amountMinor`. */
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
      select: { id: true, status: true, counterpartyId: true, reference: true },
    })
    if (!existing) throw new NotFoundError('Transaction')

    const tx = await prisma.transaction.update({
      where: { id: param(req, 'id') },
      data: {
        ...input,
        ...(input.status === TransactionStatus.PAID && !input.settledAt
          ? { settledAt: new Date() }
          : {}),
      },
      select: txSelect,
    })

    if (input.status && input.status !== existing.status && existing.counterpartyId) {
      await createNotification({
        userId: existing.counterpartyId,
        type: 'TRANSACTION_UPDATED',
        title: `${existing.reference} is now ${input.status.toLowerCase()}`,
        link: '/app/transactions',
      })
    }

    await recordAudit({
      req,
      action: 'transaction.updated',
      entityType: 'Transaction',
      entityId: tx.id,
      before: { status: existing.status },
      after: input,
    })

    res.json({ data: withOutstanding(req.user!, tx) })
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

/**
 * An earning that counts as CREDITED — money the tester has been told is
 * theirs. It may or may not be withdrawable yet.
 */
const CREDITED_EARNING_STATUSES: TransactionStatus[] = [
  TransactionStatus.APPROVED,
  TransactionStatus.RELEASED,
  TransactionStatus.PAID,
]

/**
 * An earning that has been RELEASED — withdrawable.
 *
 * `PAID` is included because releasing is a precondition of paying: a row that
 * reached PAID was necessarily released, and older rows recorded before this
 * stage existed went straight from APPROVED to PAID. Excluding PAID would make
 * every historical payout look unreleased and drop the balance below what was
 * actually settled.
 */
const RELEASED_EARNING_STATUSES: TransactionStatus[] = [
  TransactionStatus.RELEASED,
  TransactionStatus.PAID,
]

/**
 * A payout the tester has raised that has not finished.
 *
 * RELEASED counts: the funds were authorised but not paid, so the request is
 * very much still live and a second one would double-claim the same balance.
 * Shared by the read and the write below so the two cannot disagree about what
 * "already in progress" means.
 */
const OPEN_PAYOUT_STATUSES: TransactionStatus[] = [
  TransactionStatus.PENDING,
  TransactionStatus.APPROVED,
  TransactionStatus.RELEASED,
]

/**
 * The tester's money, at all three stages.
 *
 *   credited          every APPROVED / RELEASED / PAID earning
 *   released          the RELEASED / PAID subset — withdrawable
 *   awaiting release  credited − released, held back by an operator
 *   available         released − everything already requested
 *
 * A PENDING earning counts as nothing: an admin has not confirmed it, and
 * paying it would be paying for work that might still be rejected.
 *
 * Withdrawal keys off RELEASED, not APPROVED. That is the whole point of the
 * stage — approving an earning says the work was accepted, releasing it says
 * the money can leave. Before the stage existed APPROVED had to mean both,
 * which overstated what a tester could actually take.
 *
 * On the other side every payout that has not been CANCELLED or FAILED counts
 * against the balance, including ones still PENDING — otherwise a tester could
 * submit the same balance twice before the first was settled.
 */
async function payoutBalance(testerId: string): Promise<{
  /** Released, minus everything already requested. What may be withdrawn now. */
  availableMinor: bigint
  /** Every credited earning, released or not. */
  creditedMinor: bigint
  /** The released subset of the above. */
  releasedMinor: bigint
  /** Credited but still held back. */
  awaitingReleaseMinor: bigint
  /** Payouts already raised and not cancelled or failed. */
  requestedMinor: bigint
}> {
  const [credited, released, requested] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        counterpartyId: testerId,
        type: TransactionType.TESTER_EARNING,
        status: { in: CREDITED_EARNING_STATUSES },
      },
      _sum: { amountMinor: true },
    }),
    prisma.transaction.aggregate({
      where: {
        counterpartyId: testerId,
        type: TransactionType.TESTER_EARNING,
        status: { in: RELEASED_EARNING_STATUSES },
      },
      _sum: { amountMinor: true },
    }),
    prisma.transaction.aggregate({
      where: {
        counterpartyId: testerId,
        type: TransactionType.TESTER_PAYOUT,
        status: { notIn: [TransactionStatus.CANCELLED, TransactionStatus.FAILED] },
      },
      _sum: { amountMinor: true },
    }),
  ])

  const creditedMinor = credited._sum.amountMinor ?? 0n
  const releasedMinor = released._sum.amountMinor ?? 0n
  const requestedMinor = requested._sum.amountMinor ?? 0n
  const availableMinor = releasedMinor - requestedMinor
  const awaitingReleaseMinor = creditedMinor - releasedMinor

  return {
    creditedMinor,
    releasedMinor,
    requestedMinor,
    awaitingReleaseMinor: awaitingReleaseMinor > 0n ? awaitingReleaseMinor : 0n,
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
  if (req.user!.role !== Role.TESTER) throw new BadRequestError('Only a tester has a payout balance')

  const [balance, account, openRequest] = await Promise.all([
    payoutBalance(req.user!.id),
    prisma.paymentAccount.findFirst({
      where: { userId: req.user!.id, status: 'ACTIVE' },
      select: { id: true, paymentType: true },
    }),
    prisma.transaction.findFirst({
      where: {
        counterpartyId: req.user!.id,
        type: TransactionType.TESTER_PAYOUT,
        status: { in: OPEN_PAYOUT_STATUSES },
      },
      select: { id: true, reference: true, amountMinor: true, status: true, occurredAt: true },
      orderBy: { occurredAt: 'desc' },
    }),
  ])

  const meetsMinimum = balance.availableMinor >= PAYOUT_MINIMUM_MINOR

  res.json({
    data: {
      currency: 'INR',
      availableMinor: balance.availableMinor.toString(),
      /** Everything credited, released or not — legacy "Credit Fund". */
      creditedMinor: balance.creditedMinor.toString(),
      /** The released subset — legacy "Release Fund". */
      releasedMinor: balance.releasedMinor.toString(),
      /** Credited but not yet released, so not yet withdrawable. */
      awaitingReleaseMinor: balance.awaitingReleaseMinor.toString(),
      requestedMinor: balance.requestedMinor.toString(),
      minimumMinor: PAYOUT_MINIMUM_MINOR.toString(),
      hasPaymentAccount: Boolean(account),
      meetsMinimum,
      openRequest: openRequest
        ? { ...openRequest, amountMinor: openRequest.amountMinor.toString() }
        : null,
      canRequest: Boolean(account) && meetsMinimum && !openRequest,
    },
  })
})

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
 * Creates a PENDING `TESTER_PAYOUT` that an admin then approves and settles
 * through the existing PATCH route. Nothing here moves money; see the module
 * note. The tester is the only one who can call this for themselves —
 * `counterpartyId` comes from the session and is never read from the body, so
 * a tester cannot request a payout against someone else's balance.
 */
transactionsRouter.post(
  '/payouts/request',
  validate({ body: requestPayoutSchema }),
  async (req, res) => {
    if (req.user!.role !== Role.TESTER) {
      throw new BadRequestError('Only a tester can request a payout')
    }
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
    const openRequest = await prisma.transaction.findFirst({
      where: {
        counterpartyId: req.user!.id,
        type: TransactionType.TESTER_PAYOUT,
        status: { in: OPEN_PAYOUT_STATUSES },
      },
      select: { id: true, reference: true },
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

    const tx = await prisma.transaction.create({
      data: {
        type: TransactionType.TESTER_PAYOUT,
        status: TransactionStatus.PENDING,
        amountMinor,
        currency: 'INR',
        counterpartyId: req.user!.id,
        paymentAccountId: account.id,
        paymentMethod: account.paymentType,
        description: input.note,
        occurredAt: new Date(),
        reference: await nextReference('transaction'),
        // The tester raised it themselves — there is no admin to credit.
        recordedById: req.user!.id,
      },
      select: txSelect,
    })

    await recordAudit({
      req,
      action: 'transaction.payout_requested',
      entityType: 'Transaction',
      entityId: tx.id,
      after: { reference: tx.reference, amountMinor: tx.amountMinor.toString() },
    })

    res.status(201).json({ data: withOutstanding(req.user!, tx) })
  },
)

/** §2.3 — a tester's own earnings summary. */
transactionsRouter.get('/summary/mine', async (req, res) => {
  const [grouped, tds] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['type', 'status'],
      where: { counterpartyId: req.user!.id },
      _sum: { amountMinor: true },
      _count: true,
    }),
    // A separate aggregate: the groupBy above sums `amountMinor` only, so TDS
    // cannot be derived from it.
    prisma.transaction.aggregate({
      where: { counterpartyId: req.user!.id },
      _sum: { tdsAmountMinor: true },
    }),
  ])

  const sum = (type: TransactionType, status?: TransactionStatus) =>
    grouped
      .filter((g) => g.type === type && (!status || g.status === status))
      .reduce((acc, g) => acc + (g._sum.amountMinor ?? 0n), 0n)
      .toString()

  res.json({
    data: {
      currency: 'INR',
      earnedTotalMinor: sum(TransactionType.TESTER_EARNING),
      earnedApprovedMinor: sum(TransactionType.TESTER_EARNING, TransactionStatus.APPROVED),
      earnedReleasedMinor: sum(TransactionType.TESTER_EARNING, TransactionStatus.RELEASED),
      earnedPendingMinor: sum(TransactionType.TESTER_EARNING, TransactionStatus.PENDING),
      paidOutMinor: sum(TransactionType.TESTER_PAYOUT, TransactionStatus.PAID),
      /**
       * TDS withheld across every row that recorded it. The column has existed
       * since the payout-accounts pass but nothing surfaced it, so a tester
       * could not see what had been deducted on their behalf.
       */
      tdsWithheldMinor: (tds._sum.tdsAmountMinor ?? 0n).toString(),
    },
  })
})

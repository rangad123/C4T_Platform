import { Router } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { TransactionType, TransactionStatus, Role, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
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
  organisation: { select: { id: true, name: true } },
  project: { select: { id: true, reference: true, title: true } },
  counterparty: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
  recordedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.TransactionSelect

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

const listQuery = paginationQuery.extend({
  type: z.nativeEnum(TransactionType).optional(),
  status: z.nativeEnum(TransactionStatus).optional(),
  organisationId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  counterpartyId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

/** Shared where-builder so the list and export endpoints never drift apart. */
function transactionWhere(
  user: Express.AuthenticatedUser,
  query: z.infer<typeof listQuery>,
): Prisma.TransactionWhereInput {
  return {
    ...transactionScope(user),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.organisationId ? { organisationId: query.organisationId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.counterpartyId ? { counterpartyId: query.counterpartyId } : {}),
    ...(query.from || query.to
      ? {
          occurredAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  }
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
    data: items,
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

  const rows = items.map((t) => [
    t.reference,
    t.type,
    t.status,
    // BigInt minor units, converted to a plain decimal string for the
    // spreadsheet — Excel/Sheets read "150000" as 150000, not ₹1,500.00, so
    // divide by 100 here rather than exporting the raw minor-unit integer.
    (Number(t.amountMinor) / 100).toFixed(2),
    t.currency,
    t.description ?? '',
    t.organisation?.name ?? '',
    t.project?.reference ?? '',
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
      'Currency',
      'Description',
      'Organisation',
      'Project',
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
    res.json({ data: tx })
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

    res.status(201).json({ data: tx })
  },
)

const updateSchema = z.object({
  status: z.nativeEnum(TransactionStatus).optional(),
  description: z.string().trim().max(1000).optional(),
  externalRef: z.string().trim().max(120).optional(),
  settledAt: z.coerce.date().nullable().optional(),
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

    res.json({ data: tx })
  },
)

/** §2.3 — a tester's own earnings summary. */
transactionsRouter.get('/summary/mine', async (req, res) => {
  const grouped = await prisma.transaction.groupBy({
    by: ['type', 'status'],
    where: { counterpartyId: req.user!.id },
    _sum: { amountMinor: true },
    _count: true,
  })

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
      earnedPendingMinor: sum(TransactionType.TESTER_EARNING, TransactionStatus.PENDING),
      paidOutMinor: sum(TransactionType.TESTER_PAYOUT, TransactionStatus.PAID),
    },
  })
})

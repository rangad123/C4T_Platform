import { Router, type Request } from 'express'
import { z } from 'zod'
import { Role } from '@prisma/client'
import { param } from '../../lib/http.js'
import { authenticate } from '../../middleware/authenticate.js'
import { hasPermission, requirePermission, requireRole } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { PERMISSIONS } from '../../config/permissions.js'
import * as finance from './org-finance.service.js'

/**
 * Customer finance: organisation wallets with escrow per build, plans, and the
 * per-build tester reward. See `org-finance.service.ts` for the money rules.
 *
 *   Admin side — reads with `transaction.read`, every write with `transaction.write`.
 *   Customer   — reads the wallets of organisations they belong to. No writes.
 *   Tester     — nothing here; the reward reaches them on the build itself.
 */
export const orgFinanceRouter = Router()

orgFinanceRouter.use(authenticate)

const cuid = z.string().cuid()
const orgParam = z.object({ orgId: cuid })
const buildParam = z.object({ buildId: cuid })
/** A client-made key, one per submitted form, so a retried submit is the same move. */
const key = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, 'key must be 8–100 letters, digits, - or _')
const money = z.coerce.bigint().positive('Amount must be greater than zero')
const currency = z.string().trim().length(3).toUpperCase()

function json<T extends { transaction: unknown; replayed: boolean }>(result: T) {
  return { data: result.transaction, meta: { replayed: result.replayed } }
}

/**
 * Admin side with `transaction.read`, or a customer who is a member. A
 * customer asking about another organisation gets a 404, not a 403, so the
 * answer does not confirm the organisation exists.
 */
async function assertCanReadWallet(req: Request, orgId: string): Promise<void> {
  const user = req.user!
  if (user.role === Role.ADMIN || user.role === Role.SUB_ADMIN) {
    if (!hasPermission(user, PERMISSIONS.TRANSACTION_READ)) {
      throw new ForbiddenError('Missing required permission: transaction.read')
    }
    return
  }
  if (user.role === Role.CUSTOMER) {
    const mine = await finance.memberOrganisationIds(user.id)
    if (mine.includes(orgId)) return
    throw new NotFoundError('Organisation')
  }
  throw new ForbiddenError('Your role does not have access to this resource')
}

/** A customer's own wallets, one per organisation they belong to. */
orgFinanceRouter.get('/mine', requireRole(Role.CUSTOMER), async (req, res) => {
  const ids = await finance.memberOrganisationIds(req.user!.id)
  const wallets = await Promise.all(ids.map((id) => finance.getWallet(id)))
  res.json({ data: wallets })
})

orgFinanceRouter.get('/organisations/:orgId', validate({ params: orgParam }), async (req, res) => {
  const orgId = param(req, 'orgId')
  await assertCanReadWallet(req, orgId)
  res.json({ data: await finance.getWallet(orgId) })
})

const topUpSchema = z.object({
  amountMinor: money,
  currency: currency.default('INR'),
  key,
  externalRef: z.string().trim().max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  occurredAt: z.coerce.date().default(() => new Date()),
})

orgFinanceRouter.post(
  '/organisations/:orgId/top-ups',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ params: orgParam, body: topUpSchema }),
  async (req, res) => {
    const orgId = param(req, 'orgId')
    const result = await finance.topUp(req.user!.id, orgId, req.body)
    if (!result.replayed) {
      await recordAudit({
        req,
        action: 'organisation.wallet_top_up',
        entityType: 'Organisation',
        entityId: orgId,
        after: {
          reference: result.transaction.reference,
          amountMinor: result.transaction.amountMinor.toString(),
        },
      })
    }
    res.status(result.replayed ? 200 : 201).json(json(result))
  },
)

const lockSchema = z.object({
  amountMinor: money,
  key,
  description: z.string().trim().max(1000).optional(),
})

orgFinanceRouter.post(
  '/builds/:buildId/lock',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ params: buildParam, body: lockSchema }),
  async (req, res) => {
    const buildId = param(req, 'buildId')
    const result = await finance.lockForBuild(req.user!.id, buildId, req.body)
    if (!result.replayed) {
      await recordAudit({
        req,
        action: 'build.funds_locked',
        entityType: 'Build',
        entityId: buildId,
        after: {
          reference: result.transaction.reference,
          amountMinor: result.transaction.amountMinor.toString(),
        },
      })
    }
    res.status(result.replayed ? 200 : 201).json(json(result))
  },
)

orgFinanceRouter.post(
  '/builds/:buildId/release',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ params: buildParam }),
  async (req, res) => {
    const buildId = param(req, 'buildId')
    const result = await finance.releaseForBuild(req.user!.id, buildId)
    if (!result.replayed) {
      await recordAudit({
        req,
        action: 'build.funds_released',
        entityType: 'Build',
        entityId: buildId,
        after: {
          reference: result.transaction.reference,
          amountMinor: result.transaction.amountMinor.toString(),
        },
      })
    }
    res.status(result.replayed ? 200 : 201).json(json(result))
  },
)

const rewardSchema = z.object({
  /** Minor units per accepted bug; null clears it. */
  testerRewardMinor: z.union([z.null(), z.coerce.bigint().nonnegative()]),
  rewardsCurrency: currency.default('INR'),
})

orgFinanceRouter.put(
  '/builds/:buildId/reward',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ params: buildParam, body: rewardSchema }),
  async (req, res) => {
    const buildId = param(req, 'buildId')
    const build = await finance.setBuildReward(buildId, req.body)
    await recordAudit({
      req,
      action: 'build.reward_set',
      entityType: 'Build',
      entityId: buildId,
      after: {
        testerRewardMinor: build.testerRewardMinor?.toString() ?? null,
        rewardsCurrency: build.rewardsCurrency,
      },
    })
    res.json({ data: build })
  },
)

// ─── Plans ──────────────────────────────────────────────────────────────────

const quota = z.coerce.number().int().nonnegative().nullable().optional()
const planSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(1000).nullable().optional(),
  priceMinor: z.union([z.null(), z.coerce.bigint().nonnegative()]).optional(),
  currency: currency.default('INR'),
  projectsIncluded: quota,
  privateTestersIncluded: quota,
})

orgFinanceRouter.get(
  '/plans',
  requirePermission(PERMISSIONS.TRANSACTION_READ),
  async (_req, res) => {
    res.json({ data: await finance.listPlans() })
  },
)

orgFinanceRouter.post(
  '/plans',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ body: planSchema }),
  async (req, res) => {
    const plan = await finance.createPlan(req.body)
    await recordAudit({
      req,
      action: 'plan.created',
      entityType: 'PricingPlan',
      entityId: plan.id,
      after: { name: plan.name },
    })
    res.status(201).json({ data: plan })
  },
)

orgFinanceRouter.patch(
  '/plans/:planId',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({
    params: z.object({ planId: cuid }),
    body: planSchema.partial().extend({ archived: z.boolean().optional() }),
  }),
  async (req, res) => {
    const plan = await finance.updatePlan(param(req, 'planId'), req.body)
    await recordAudit({
      req,
      action: 'plan.updated',
      entityType: 'PricingPlan',
      entityId: plan.id,
      after: { name: plan.name, archived: plan.archivedAt !== null },
    })
    res.json({ data: plan })
  },
)

const assignPlanSchema = z.object({
  planId: cuid,
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  remainingProjects: quota,
  remainingPrivateTesters: quota,
})

orgFinanceRouter.post(
  '/organisations/:orgId/plans',
  requirePermission(PERMISSIONS.TRANSACTION_WRITE),
  validate({ params: orgParam, body: assignPlanSchema }),
  async (req, res) => {
    const orgId = param(req, 'orgId')
    const active = await finance.assignPlan(orgId, req.body)
    await recordAudit({
      req,
      action: 'organisation.plan_assigned',
      entityType: 'Organisation',
      entityId: orgId,
      after: {
        planId: active.plan.id,
        startDate: active.startDate.toISOString(),
        endDate: active.endDate?.toISOString() ?? null,
      },
    })
    res.status(201).json({ data: active })
  },
)

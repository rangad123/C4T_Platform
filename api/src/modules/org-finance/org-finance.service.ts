import { BuildStatus, Prisma, TransactionType, WalletMove } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { nextReference } from '../../lib/reference.js'

/**
 * Customer finance: an organisation's wallet, the escrow it locks per build,
 * and the plan it holds. Legacy `org_wallet_balance` / `locked_amount`.
 *
 * Recording only. Nothing here talks to a bank or a gateway: an admin records
 * that the customer paid, and the platform keeps the two figures straight.
 *
 *   balance — money the customer has paid in that is not set aside yet
 *   locked  — money set aside for builds (escrow)
 *
 * Every move is a `Transaction` row tagged with `walletMove`, written in the
 * same DB transaction as the change to the two figures, under one advisory
 * lock per organisation, so concurrent moves are applied one at a time and
 * neither figure can go below zero. A move with a `walletKey` it has already
 * seen returns the first row instead of moving the money again.
 */

type Db = Prisma.TransactionClient

/** Serialises every wallet move on one organisation, for the rest of the DB transaction. */
async function lockWallet(db: Db, organisationId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org-wallet:${organisationId}`}))`
}

const walletRowSelect = {
  id: true,
  reference: true,
  type: true,
  walletMove: true,
  amountMinor: true,
  currency: true,
  description: true,
  externalRef: true,
  occurredAt: true,
  project: { select: { id: true, reference: true, title: true } },
  build: { select: { id: true, name: true } },
  /// Name only: a customer reads this list too, and an email is not theirs to have.
  counterparty: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.TransactionSelect

/** What a build's escrow holds, from its ledger rows. */
async function escrowOf(db: Db, buildId: string) {
  const sums = await db.transaction.groupBy({
    by: ['walletMove'],
    where: { buildId, walletMove: { in: [WalletMove.LOCK, WalletMove.DRAW, WalletMove.RELEASE] } },
    _sum: { amountMinor: true },
  })
  const sum = (move: WalletMove) => sums.find((s) => s.walletMove === move)?._sum.amountMinor ?? 0n
  const lockedMinor = sum(WalletMove.LOCK)
  const drawnMinor = sum(WalletMove.DRAW)
  const releasedMinor = sum(WalletMove.RELEASE)
  return {
    lockedMinor,
    drawnMinor,
    releasedMinor,
    remainingMinor: lockedMinor - drawnMinor - releasedMinor,
  }
}

async function buildWithOrg(buildId: string) {
  const build = await prisma.build.findFirst({
    where: { id: buildId, deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      projectId: true,
      project: { select: { organisationId: true } },
    },
  })
  if (!build) throw new NotFoundError('Build')
  return build
}

/** A retry with a key already used must be the same request, or it is refused. */
function assertSameReplay(
  existing: { organisationId: string | null; buildId: string | null; amountMinor: bigint },
  expected: { organisationId: string; buildId?: string; amountMinor: bigint },
): void {
  if (
    existing.organisationId !== expected.organisationId ||
    (expected.buildId !== undefined && existing.buildId !== expected.buildId) ||
    existing.amountMinor !== expected.amountMinor
  ) {
    throw new ConflictError('That key was already used for a different wallet move')
  }
}

// ─── Moves ──────────────────────────────────────────────────────────────────

export interface TopUpInput {
  amountMinor: bigint
  currency: string
  key: string
  externalRef?: string
  description?: string
  occurredAt: Date
}

/** A customer payment, recorded by an admin: balance up. */
export async function topUp(recordedById: string, organisationId: string, input: TopUpInput) {
  const org = await prisma.organisation.findFirst({
    where: { id: organisationId, deletedAt: null },
    select: { id: true, walletCurrency: true },
  })
  if (!org) throw new NotFoundError('Organisation')
  if (input.currency !== org.walletCurrency) {
    throw new BadRequestError(`This organisation's wallet is in ${org.walletCurrency}`)
  }
  const walletKey = `topup:${input.key}`
  const reference = await nextReference('transaction')

  return prisma.$transaction(async (db) => {
    await lockWallet(db, org.id)
    const existing = await db.transaction.findUnique({ where: { walletKey } })
    if (existing) {
      assertSameReplay(existing, { organisationId: org.id, amountMinor: input.amountMinor })
      return { replayed: true, transaction: await rowById(db, existing.id) }
    }
    const created = await db.transaction.create({
      data: {
        reference,
        type: TransactionType.CUSTOMER_PAYMENT,
        walletMove: WalletMove.TOP_UP,
        walletKey,
        amountMinor: input.amountMinor,
        currency: org.walletCurrency,
        organisationId: org.id,
        recordedById,
        description: input.description ?? 'Wallet top-up',
        externalRef: input.externalRef,
        occurredAt: input.occurredAt,
        paidAmountMinor: input.amountMinor,
      },
      select: walletRowSelect,
    })
    await db.organisation.update({
      where: { id: org.id },
      data: { walletBalanceMinor: { increment: input.amountMinor } },
    })
    return { replayed: false, transaction: created }
  })
}

/** Funds a build: balance down, locked up. Refused once the build's escrow is released. */
export async function lockForBuild(
  recordedById: string,
  buildId: string,
  input: { amountMinor: bigint; key: string; description?: string },
) {
  const build = await buildWithOrg(buildId)
  const organisationId = build.project.organisationId
  const walletKey = `lock:${input.key}`
  const reference = await nextReference('transaction')

  return prisma.$transaction(async (db) => {
    await lockWallet(db, organisationId)
    const existing = await db.transaction.findUnique({ where: { walletKey } })
    if (existing) {
      assertSameReplay(existing, { organisationId, buildId, amountMinor: input.amountMinor })
      return { replayed: true, transaction: await rowById(db, existing.id) }
    }
    if (build.status === BuildStatus.CLOSED) {
      throw new BadRequestError('This build is closed, so no more funds can be locked for it')
    }
    const escrow = await escrowOf(db, buildId)
    if (escrow.releasedMinor > 0n) {
      throw new BadRequestError("This build's locked funds were already released")
    }
    const org = await db.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { walletBalanceMinor: true, walletCurrency: true },
    })
    if (org.walletBalanceMinor < input.amountMinor) {
      throw new BadRequestError('That is more than the organisation has in its wallet')
    }
    const created = await db.transaction.create({
      data: {
        reference,
        type: TransactionType.ADJUSTMENT,
        walletMove: WalletMove.LOCK,
        walletKey,
        amountMinor: input.amountMinor,
        currency: org.walletCurrency,
        organisationId,
        projectId: build.projectId,
        buildId,
        recordedById,
        description: input.description ?? `Funds locked for ${build.name}`,
        occurredAt: new Date(),
      },
      select: walletRowSelect,
    })
    const moved = await db.organisation.updateMany({
      where: { id: organisationId, walletBalanceMinor: { gte: input.amountMinor } },
      data: {
        walletBalanceMinor: { decrement: input.amountMinor },
        lockedAmountMinor: { increment: input.amountMinor },
      },
    })
    if (moved.count !== 1) {
      throw new BadRequestError('That is more than the organisation has in its wallet')
    }
    return { replayed: false, transaction: created }
  })
}

/**
 * Returns what is left of a closed build's lock to the balance. Once per
 * build: the key is the build, so a retry finds the first release.
 */
export async function releaseForBuild(recordedById: string, buildId: string) {
  const build = await buildWithOrg(buildId)
  const organisationId = build.project.organisationId
  const walletKey = `release:${buildId}`
  const reference = await nextReference('transaction')

  return prisma.$transaction(async (db) => {
    await lockWallet(db, organisationId)
    const existing = await db.transaction.findUnique({ where: { walletKey } })
    if (existing) return { replayed: true, transaction: await rowById(db, existing.id) }
    if (build.status !== BuildStatus.CLOSED) {
      throw new BadRequestError('Close the build before releasing its locked funds')
    }
    const escrow = await escrowOf(db, buildId)
    if (escrow.remainingMinor <= 0n) {
      throw new BadRequestError('Nothing is left locked on this build')
    }
    const org = await db.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { walletCurrency: true },
    })
    const created = await db.transaction.create({
      data: {
        reference,
        type: TransactionType.ADJUSTMENT,
        walletMove: WalletMove.RELEASE,
        walletKey,
        amountMinor: escrow.remainingMinor,
        currency: org.walletCurrency,
        organisationId,
        projectId: build.projectId,
        buildId,
        recordedById,
        description: `Unused funds released from ${build.name}`,
        occurredAt: new Date(),
      },
      select: walletRowSelect,
    })
    const moved = await db.organisation.updateMany({
      where: { id: organisationId, lockedAmountMinor: { gte: escrow.remainingMinor } },
      data: {
        lockedAmountMinor: { decrement: escrow.remainingMinor },
        walletBalanceMinor: { increment: escrow.remainingMinor },
      },
    })
    if (moved.count !== 1) throw new ConflictError('The wallet figures disagree with the ledger')
    return { replayed: false, transaction: created }
  })
}

/**
 * Called from `POST /transactions` inside its DB transaction, before the
 * TESTER_EARNING row is written. A build that has funds locked pays its
 * testers out of that lock: the earning must fit in what is left, and the
 * organisation's locked figure goes down by it. A build that never had funds
 * locked returns null and the earning is recorded exactly as before.
 *
 * The returned fields go onto the earning row, which is the DRAW record.
 */
export async function drawForEarning(
  db: Db,
  input: { buildId: string; amountMinor: bigint; currency: string },
): Promise<{ walletMove: WalletMove; organisationId: string } | null> {
  const build = await db.build.findFirst({
    where: { id: input.buildId },
    select: { project: { select: { organisationId: true } } },
  })
  if (!build) return null
  const organisationId = build.project.organisationId
  await lockWallet(db, organisationId)
  const escrow = await escrowOf(db, input.buildId)
  if (escrow.lockedMinor === 0n) return null

  if (escrow.releasedMinor > 0n) {
    throw new BadRequestError("This build's locked funds were already released")
  }
  const org = await db.organisation.findUniqueOrThrow({
    where: { id: organisationId },
    select: { walletCurrency: true },
  })
  if (input.currency !== org.walletCurrency) {
    throw new BadRequestError(`This build is funded in ${org.walletCurrency}`)
  }
  if (input.amountMinor > escrow.remainingMinor) {
    throw new BadRequestError(
      'That is more than is left locked for this build. Lock more funds for it first.',
    )
  }
  const moved = await db.organisation.updateMany({
    where: { id: organisationId, lockedAmountMinor: { gte: input.amountMinor } },
    data: { lockedAmountMinor: { decrement: input.amountMinor } },
  })
  if (moved.count !== 1) throw new ConflictError('The wallet figures disagree with the ledger')
  return { walletMove: WalletMove.DRAW, organisationId }
}

function rowById(db: Db, id: string) {
  return db.transaction.findUniqueOrThrow({ where: { id }, select: walletRowSelect })
}

// ─── Reward and plans ───────────────────────────────────────────────────────

export async function setBuildReward(
  buildId: string,
  input: { testerRewardMinor: bigint | null; rewardsCurrency: string },
) {
  await buildWithOrg(buildId)
  return prisma.build.update({
    where: { id: buildId },
    data: {
      testerRewardMinor: input.testerRewardMinor,
      rewardsCurrency: input.testerRewardMinor === null ? null : input.rewardsCurrency,
    },
    select: { id: true, testerRewardMinor: true, rewardsCurrency: true },
  })
}

const planSelect = {
  id: true,
  name: true,
  description: true,
  priceMinor: true,
  currency: true,
  projectsIncluded: true,
  privateTestersIncluded: true,
  archivedAt: true,
} satisfies Prisma.PricingPlanSelect

export function listPlans() {
  return prisma.pricingPlan.findMany({
    orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    select: planSelect,
  })
}

export interface PlanInput {
  name: string
  description?: string | null
  priceMinor?: bigint | null
  currency: string
  projectsIncluded?: number | null
  privateTestersIncluded?: number | null
}

export async function createPlan(input: PlanInput) {
  try {
    return await prisma.pricingPlan.create({ data: input, select: planSelect })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('A plan with this name already exists')
    }
    throw error
  }
}

export async function updatePlan(id: string, input: Partial<PlanInput> & { archived?: boolean }) {
  const { archived, ...rest } = input
  const existing = await prisma.pricingPlan.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new NotFoundError('Plan')
  try {
    return await prisma.pricingPlan.update({
      where: { id },
      data: {
        ...rest,
        ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
      },
      select: planSelect,
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('A plan with this name already exists')
    }
    throw error
  }
}

export async function assignPlan(
  organisationId: string,
  input: {
    planId: string
    startDate: Date
    endDate?: Date | null
    remainingProjects?: number | null
    remainingPrivateTesters?: number | null
  },
) {
  const [org, plan] = await Promise.all([
    prisma.organisation.findFirst({
      where: { id: organisationId, deletedAt: null },
      select: { id: true },
    }),
    prisma.pricingPlan.findUnique({ where: { id: input.planId }, select: { archivedAt: true } }),
  ])
  if (!org) throw new NotFoundError('Organisation')
  if (!plan) throw new BadRequestError('That plan does not exist')
  if (plan.archivedAt) throw new BadRequestError('That plan is archived')
  if (input.endDate && input.endDate < input.startDate) {
    throw new BadRequestError('The plan cannot end before it starts')
  }
  return prisma.activePlan.create({
    data: { organisationId, ...input },
    select: activePlanSelect,
  })
}

const activePlanSelect = {
  id: true,
  startDate: true,
  endDate: true,
  remainingProjects: true,
  remainingPrivateTesters: true,
  createdAt: true,
  plan: { select: planSelect },
} satisfies Prisma.ActivePlanSelect

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The whole wallet page for one organisation. Callers check access first. */
export async function getWallet(organisationId: string) {
  const org = await prisma.organisation.findFirst({
    where: { id: organisationId, deletedAt: null },
    select: {
      id: true,
      name: true,
      walletBalanceMinor: true,
      lockedAmountMinor: true,
      walletCurrency: true,
    },
  })
  if (!org) throw new NotFoundError('Organisation')

  const now = new Date()
  const [builds, sums, plans, history] = await Promise.all([
    prisma.build.findMany({
      where: { deletedAt: null, project: { organisationId, deletedAt: null } },
      orderBy: [{ project: { createdAt: 'desc' } }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        status: true,
        testerRewardMinor: true,
        rewardsCurrency: true,
        project: { select: { id: true, reference: true, title: true } },
      },
    }),
    prisma.transaction.groupBy({
      by: ['buildId', 'walletMove'],
      where: {
        organisationId,
        buildId: { not: null },
        walletMove: { in: [WalletMove.LOCK, WalletMove.DRAW, WalletMove.RELEASE] },
      },
      _sum: { amountMinor: true },
    }),
    prisma.activePlan.findMany({
      where: { organisationId },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: activePlanSelect,
    }),
    prisma.transaction.findMany({
      where: { organisationId, walletMove: { not: null } },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: walletRowSelect,
    }),
  ])

  const sum = (buildId: string, move: WalletMove) =>
    sums.find((s) => s.buildId === buildId && s.walletMove === move)?._sum.amountMinor ?? 0n

  const current =
    plans.find((p) => p.startDate <= now && (p.endDate === null || p.endDate >= now)) ?? null

  return {
    organisation: { id: org.id, name: org.name },
    currency: org.walletCurrency,
    balanceMinor: org.walletBalanceMinor,
    lockedMinor: org.lockedAmountMinor,
    builds: builds.map((b) => {
      const lockedTotal = sum(b.id, WalletMove.LOCK)
      const drawn = sum(b.id, WalletMove.DRAW)
      const released = sum(b.id, WalletMove.RELEASE)
      return {
        ...b,
        lockedTotalMinor: lockedTotal,
        drawnMinor: drawn,
        releasedMinor: released,
        remainingMinor: lockedTotal - drawn - released,
      }
    }),
    currentPlan: current,
    plans,
    history,
  }
}

/** Ids of the organisations a customer belongs to. */
export async function memberOrganisationIds(userId: string): Promise<string[]> {
  const rows = await prisma.organisationMember.findMany({
    where: { userId, organisation: { deletedAt: null } },
    select: { organisationId: true },
  })
  return rows.map((r) => r.organisationId)
}

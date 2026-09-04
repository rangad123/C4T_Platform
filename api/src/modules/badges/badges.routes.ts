import { Router } from 'express'
import { z } from 'zod'
import { Role, type Prisma } from '@prisma/client'
import { param } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { isAdminSide } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { buildMeta, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { createNotification } from '../notifications/notifications.service.js'
import { assertWorkedTogether } from '../../lib/access/worked-together.js'

/**
 * Badges — named recognition a tester earns on a project.
 *
 * The qualitative counterpart to `Rating`: a rating says how well the work
 * went as one number, a badge says WHAT was good about it in a word the
 * whole platform shares. Who may award one, and on what, is deliberately the
 * same question as who may rate — both go through `assertWorkedTogether`, so
 * the two can never drift into disagreeing about whether a piece of work
 * happened.
 *
 * The catalogue is seeded, not user-created: a free-text badge would be a
 * second comment field, and the point of a badge is that "Bug hunter" means
 * the same thing on every profile that carries it.
 */
export const badgesRouter = Router()

badgesRouter.use(authenticate)

const badgeSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  icon: true,
} satisfies Prisma.BadgeSelect

const awardSelect = {
  id: true,
  note: true,
  createdAt: true,
  badge: { select: badgeSelect },
  tester: { select: { id: true, firstName: true, lastName: true } },
  awardedBy: { select: { id: true, firstName: true, lastName: true, role: true } },
  project: { select: { id: true, reference: true, title: true } },
} satisfies Prisma.TesterBadgeSelect

/** The catalogue. Everyone signed in can read it — an award UI needs the options. */
badgesRouter.get('/', async (_req, res) => {
  const badges = await prisma.badge.findMany({
    where: { isActive: true },
    select: badgeSelect,
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  })
  res.json({ data: badges })
})

/**
 * The caller's own badges — what the tester dashboard shows.
 *
 * Separate from the filtered list below so a tester never has to be granted
 * a permission to see their own recognition, and never has to pass their own
 * id to ask for it.
 */
badgesRouter.get('/awards/mine', async (req, res) => {
  const awards = await prisma.testerBadge.findMany({
    where: { testerId: req.user!.id },
    select: awardSelect,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  res.json({ data: awards })
})

const listAwardsQuery = paginationQuery.extend({
  testerUserId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
})

/**
 * Awards, filtered.
 *
 * Admin-side sees everything; a customer sees awards on their own
 * organisation's projects; a tester sees only their own (which is what
 * `/awards/mine` is for, but asking here works too rather than 403-ing).
 */
badgesRouter.get('/awards', validate({ query: listAwardsQuery }), async (req, res) => {
  const query = validatedQuery<z.infer<typeof listAwardsQuery>>(res)
  const user = req.user!

  const scope: Prisma.TesterBadgeWhereInput = isAdminSide(user)
    ? {}
    : user.role === Role.CUSTOMER
      ? { project: { organisation: { members: { some: { userId: user.id } } } } }
      : { testerId: user.id }

  const where: Prisma.TesterBadgeWhereInput = {
    ...scope,
    ...(query.testerUserId ? { testerId: query.testerUserId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
  }

  const [items, total] = await Promise.all([
    prisma.testerBadge.findMany({
      where,
      select: awardSelect,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.testerBadge.count({ where }),
  ])

  res.json({ data: items, meta: buildMeta(query, total) })
})

const awardBadgeSchema = z.object({
  badgeId: z.string().cuid(),
  testerUserId: z.string().cuid(),
  projectId: z.string().cuid(),
  note: z.string().trim().max(1000).optional(),
})

badgesRouter.post('/awards', validate({ body: awardBadgeSchema }), async (req, res) => {
  const input = req.body as z.infer<typeof awardBadgeSchema>
  const user = req.user!

  // A tester cannot hand out badges — unlike ratings, where a tester rates
  // the customer back, there is no reverse direction here to allow.
  if (user.role === Role.TESTER) {
    throw new ForbiddenError('Only the delivery team and customers can award badges')
  }
  if (input.testerUserId === user.id) {
    throw new BadRequestError('You cannot award a badge to yourself')
  }

  const badge = await prisma.badge.findFirst({
    where: { id: input.badgeId, isActive: true },
    select: { id: true, name: true },
  })
  if (!badge) throw new NotFoundError('Badge')

  // Same rule as rating: the work has to have happened, and the awarder has
  // to be entitled to speak about it.
  await assertWorkedTogether(user, input.testerUserId, input.projectId)

  const existing = await prisma.testerBadge.findFirst({
    where: {
      badgeId: input.badgeId,
      testerId: input.testerUserId,
      projectId: input.projectId,
      awardedById: user.id,
    },
    select: { id: true },
  })
  if (existing) throw new ConflictError('You have already awarded that badge on this project')

  const award = await prisma.testerBadge.create({
    data: {
      badgeId: input.badgeId,
      testerId: input.testerUserId,
      awardedById: user.id,
      projectId: input.projectId,
      note: input.note ?? null,
    },
    select: awardSelect,
  })

  await recordAudit({
    req,
    action: 'badge.awarded',
    entityType: 'TesterBadge',
    entityId: award.id,
    after: { badge: badge.name, testerId: input.testerUserId, projectId: input.projectId },
  })

  await createNotification({
    userId: input.testerUserId,
    type: 'RATING_RECEIVED',
    title: `You earned the "${badge.name}" badge`,
    body: input.note,
    link: '/app/tester',
  })

  res.status(201).json({ data: award })
})

/**
 * Take one back. The person who gave it may withdraw it; admin-side can
 * remove any, which is the moderation path for one awarded in error or in
 * bad faith — mirroring how a rating is hidden rather than left standing.
 */
badgesRouter.delete('/awards/:id', async (req, res) => {
  const user = req.user!
  const award = await prisma.testerBadge.findUnique({
    where: { id: param(req, 'id') },
    select: { id: true, awardedById: true },
  })
  if (!award) throw new NotFoundError('Badge award')

  if (award.awardedById !== user.id && !isAdminSide(user)) {
    throw new ForbiddenError('That badge is not yours to remove')
  }

  await prisma.testerBadge.delete({ where: { id: award.id } })
  await recordAudit({
    req,
    action: 'badge.revoked',
    entityType: 'TesterBadge',
    entityId: award.id,
    before: { awardedById: award.awardedById },
  })

  res.status(204).send()
})

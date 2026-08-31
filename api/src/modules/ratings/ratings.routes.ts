import { Router } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { RatingSubjectType, Role, AssignmentStatus, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission, isAdminSide } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { buildMeta, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { createNotification } from '../notifications/notifications.service.js'
import { refreshTesterAggregates } from '../testers/testers.service.js'
import { PERMISSIONS } from '../../config/permissions.js'
import { ratingScope } from '../../lib/access/scopes.js'

/**
 * §2.2 "Ratings & Reviews" — ratings given to Testers and/or by Customers.
 *
 * Rule enforced here: you may only rate someone you actually worked with on a
 * specific project. That keeps the tester rating average meaningful, which
 * matters because it is a sort key in the crowd tester pool.
 */
export const ratingsRouter = Router()

ratingsRouter.use(authenticate)

const ratingSelect = {
  id: true,
  subjectType: true,
  score: true,
  comment: true,
  isVisible: true,
  createdAt: true,
  author: { select: { id: true, firstName: true, lastName: true, role: true } },
  subjectUser: { select: { id: true, firstName: true, lastName: true, role: true } },
  project: { select: { id: true, reference: true, title: true } },
} satisfies Prisma.RatingSelect

const listQuery = paginationQuery.extend({
  subjectUserId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  subjectType: z.nativeEnum(RatingSubjectType).optional(),
})

ratingsRouter.get('/', validate({ query: listQuery }), async (req, res) => {
  const query = validatedQuery<z.infer<typeof listQuery>>(res)

  const where: Prisma.RatingWhereInput = {
    ...(query.subjectUserId ? { subjectUserId: query.subjectUserId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.subjectType ? { subjectType: query.subjectType } : {}),
    // Hidden reviews are visible to the admin side only.
    ...ratingScope(req.user!),
  }

  const [items, total] = await Promise.all([
    prisma.rating.findMany({
      where,
      select: ratingSelect,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.rating.count({ where }),
  ])

  res.json({ data: items, meta: buildMeta(query, total) })
})

/** Ratings the calling tester has received (§2.3 "View their own ratings"). */
ratingsRouter.get('/mine', validate({ query: paginationQuery }), async (req, res) => {
  const query = validatedQuery<z.infer<typeof paginationQuery>>(res)
  const where: Prisma.RatingWhereInput = { subjectUserId: req.user!.id, isVisible: true }

  const [items, total, aggregate] = await Promise.all([
    prisma.rating.findMany({
      where,
      select: ratingSelect,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.rating.count({ where }),
    prisma.rating.aggregate({ where, _avg: { score: true }, _count: { score: true } }),
  ])

  res.json({
    data: items,
    meta: {
      ...buildMeta(query, total),
      average: aggregate._avg.score,
      count: aggregate._count.score,
    },
  })
})

const createRatingSchema = z
  .object({
    subjectType: z.nativeEnum(RatingSubjectType),
    subjectUserId: z.string().cuid().optional(),
    projectId: z.string().cuid().optional(),
    score: z.coerce.number().int().min(1).max(5),
    comment: z.string().trim().max(2000).optional(),
  })
  .refine((d) => d.subjectType === RatingSubjectType.PROJECT || !!d.subjectUserId, {
    message: 'subjectUserId is required when rating a person',
    path: ['subjectUserId'],
  })

/**
 * Confirms the author and the subject genuinely shared the given project.
 * Customer → Tester: the tester was assigned to a project in the customer's org.
 * Tester → Customer: the tester was assigned to a project in that customer's org.
 */
async function assertWorkedTogether(
  author: Express.AuthenticatedUser,
  subjectUserId: string,
  projectId: string,
): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, organisationId: true },
  })
  if (!project) throw new BadRequestError('Project does not exist')

  if (author.role === Role.CUSTOMER) {
    const [isMember, wasAssigned] = await Promise.all([
      prisma.organisationMember.findFirst({
        where: { organisationId: project.organisationId, userId: author.id },
        select: { id: true },
      }),
      prisma.projectAssignment.findFirst({
        where: {
          projectId,
          testerId: subjectUserId,
          status: { in: [AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED] },
        },
        select: { id: true },
      }),
    ])
    if (!isMember) throw new ForbiddenError('That project does not belong to your organisation')
    if (!wasAssigned) throw new BadRequestError('That tester did not work on this project')
    return
  }

  if (author.role === Role.TESTER) {
    const [wasAssigned, subjectIsMember] = await Promise.all([
      prisma.projectAssignment.findFirst({
        where: {
          projectId,
          testerId: author.id,
          status: { in: [AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED] },
        },
        select: { id: true },
      }),
      prisma.organisationMember.findFirst({
        where: { organisationId: project.organisationId, userId: subjectUserId },
        select: { id: true },
      }),
    ])
    if (!wasAssigned) throw new BadRequestError('You did not work on this project')
    if (!subjectIsMember) throw new BadRequestError('That customer is not on this project')
    return
  }

  throw new ForbiddenError('Your role cannot leave ratings')
}

ratingsRouter.post('/', validate({ body: createRatingSchema }), async (req, res) => {
  const input = req.body as z.infer<typeof createRatingSchema>

  if (isAdminSide(req.user!)) {
    throw new ForbiddenError('Administrators moderate ratings rather than leaving them')
  }
  if (!input.projectId) {
    throw new BadRequestError('projectId is required — ratings are always tied to a project')
  }
  if (input.subjectUserId === req.user!.id) {
    throw new BadRequestError('You cannot rate yourself')
  }
  if (input.subjectUserId) {
    await assertWorkedTogether(req.user!, input.subjectUserId, input.projectId)
  }

  const existing = await prisma.rating.findFirst({
    where: {
      authorId: req.user!.id,
      subjectType: input.subjectType,
      subjectUserId: input.subjectUserId ?? null,
      projectId: input.projectId,
    },
    select: { id: true },
  })
  if (existing) throw new ConflictError('You have already rated this on that project')

  const rating = await prisma.rating.create({
    data: {
      authorId: req.user!.id,
      subjectType: input.subjectType,
      subjectUserId: input.subjectUserId ?? null,
      projectId: input.projectId,
      score: input.score,
      comment: input.comment ?? null,
    },
    select: ratingSelect,
  })

  /**
   * Audited because a rating changes a number the platform sorts the crowd
   * by. Moderation was already recorded; creation was not, which left the
   * hiding of a rating traceable and the leaving of one not — the wrong way
   * round, since only one of those is reversible.
   */
  await recordAudit({
    req,
    action: 'rating.created',
    entityType: 'Rating',
    entityId: rating.id,
    after: {
      subjectType: input.subjectType,
      subjectUserId: input.subjectUserId ?? null,
      projectId: input.projectId,
      score: input.score,
    },
  })

  if (input.subjectUserId) {
    await refreshTesterAggregates(input.subjectUserId)
    await createNotification({
      userId: input.subjectUserId,
      type: 'RATING_RECEIVED',
      title: `You received a ${input.score}-star rating`,
      body: input.comment,
      link: '/app/tester/ratings',
    })
  }

  res.status(201).json({ data: rating })
})

/** §2.2 — Admin moderation: hide or restore a review without deleting it. */
ratingsRouter.post(
  '/:id/visibility',
  requirePermission(PERMISSIONS.RATING_MODERATE),
  validate({
    params: z.object({ id: z.string().cuid() }),
    body: z.object({ isVisible: z.boolean(), reason: z.string().trim().max(1000).optional() }),
  }),
  async (req, res) => {
    const existing = await prisma.rating.findUnique({
      where: { id: param(req, 'id') },
      select: { id: true, subjectUserId: true },
    })
    if (!existing) throw new NotFoundError('Rating')

    const rating = await prisma.rating.update({
      where: { id: param(req, 'id') },
      data: { isVisible: req.body.isVisible },
      select: ratingSelect,
    })

    // Hiding a rating changes the tester's public average.
    if (existing.subjectUserId) await refreshTesterAggregates(existing.subjectUserId)

    await recordAudit({
      req,
      action: 'rating.visibility_changed',
      entityType: 'Rating',
      entityId: rating.id,
      after: { isVisible: req.body.isVisible, reason: req.body.reason },
    })

    res.json({ data: rating })
  },
)

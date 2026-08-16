import { Router } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { Role } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { recordAudit } from '../../lib/audit.js'
import { BadRequestError, NotFoundError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { createNotification } from '../notifications/notifications.service.js'
import { PERMISSIONS } from '../../config/permissions.js'
import { timestampedFilename } from '../../lib/csv.js'

/**
 * §2.2 "Manager Management" — internal managers and Sub-Admins overseeing
 * projects. A manager is not a separate account type: it is an ADMIN or
 * SUB_ADMIN user linked to one or more projects.
 */
export const managersRouter = Router()

managersRouter.use(authenticate)
managersRouter.use(requirePermission(PERMISSIONS.MANAGER_READ))

const MANAGER_SORT_FIELDS = ['createdAt', 'firstName', 'lastName', 'email', 'role', 'status'] as const

const listQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
})

/** Everyone eligible to manage a project, with their current load. */
managersRouter.get('/', validate({ query: listQuery }), async (_req, res) => {
  const query = validatedQuery<z.infer<typeof listQuery>>(res)

  const where = {
    role: { in: [Role.ADMIN, Role.SUB_ADMIN] },
    deletedAt: null,
    ...(query.search
      ? {
          OR: [
            { email: { contains: query.search, mode: 'insensitive' as const } },
            { firstName: { contains: query.search, mode: 'insensitive' as const } },
            { lastName: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        _count: { select: { projectsManaged: true } },
      },
      orderBy: buildOrderBy(query.sort, query.order, MANAGER_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.user.count({ where }),
  ])

  res.json({ data: items, meta: buildMeta(query, total) })
})

/**
 * CSV export — declared before "/:id" routes so "export.csv" is not consumed
 * as an id with a dot in it. Same filters as the list endpoint, no pagination.
 */
managersRouter.get('/export.csv', validate({ query: listQuery }), async (_req, res) => {
  const query = validatedQuery<z.infer<typeof listQuery>>(res)

  const where = {
    role: { in: [Role.ADMIN, Role.SUB_ADMIN] },
    deletedAt: null,
    ...(query.search
      ? {
          OR: [
            { email: { contains: query.search, mode: 'insensitive' as const } },
            { firstName: { contains: query.search, mode: 'insensitive' as const } },
            { lastName: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const items = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      status: true,
      createdAt: true,
      _count: { select: { projectsManaged: true } },
    },
    orderBy: buildOrderBy(query.sort, query.order, MANAGER_SORT_FIELDS, 'createdAt'),
  })

  const rows = items.map((m) => [
    [m.firstName, m.lastName].filter(Boolean).join(' '),
    m.email,
    m.role,
    m.status,
    m._count.projectsManaged,
    m.createdAt,
  ])

  const { toCsv } = await import('../../lib/csv.js')
  const csv = toCsv(['Name', 'Email', 'Role', 'Status', 'Projects managed', 'Created at'], rows)

  res.setHeader('content-type', 'text/csv; charset=utf-8')
  res.setHeader('content-disposition', `attachment; filename="${timestampedFilename('managers')}"`)
  res.send(csv)
})

/** Projects a given manager oversees. */
managersRouter.get(
  '/:id/projects',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const assignments = await prisma.managerAssignment.findMany({
      where: { managerId: param(req, 'id') },
      select: {
        assignedAt: true,
        project: {
          select: {
            id: true,
            reference: true,
            title: true,
            status: true,
            priority: true,
            organisation: { select: { id: true, name: true } },
            _count: { select: { bugs: true, assignments: true } },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    })
    res.json({ data: assignments })
  },
)

const assignSchema = z.object({
  managerId: z.string().cuid(),
  projectId: z.string().cuid(),
})

managersRouter.post(
  '/assignments',
  requirePermission(PERMISSIONS.MANAGER_WRITE),
  validate({ body: assignSchema }),
  async (req, res) => {
    const { managerId, projectId } = req.body as z.infer<typeof assignSchema>

    const [manager, project] = await Promise.all([
      prisma.user.findFirst({
        where: { id: managerId, deletedAt: null, role: { in: [Role.ADMIN, Role.SUB_ADMIN] } },
        select: { id: true },
      }),
      prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true, title: true },
      }),
    ])

    if (!manager) throw new BadRequestError('That user is not an admin or sub-admin')
    if (!project) throw new NotFoundError('Project')

    const assignment = await prisma.managerAssignment.upsert({
      where: { managerId_projectId: { managerId, projectId } },
      create: { managerId, projectId },
      update: {},
      select: {
        assignedAt: true,
        manager: { select: { id: true, firstName: true, lastName: true, email: true } },
        project: { select: { id: true, reference: true, title: true } },
      },
    })

    await createNotification({
      userId: managerId,
      type: 'PROJECT_ASSIGNED',
      title: `You are now managing "${project.title}"`,
      link: `/app/admin/projects/${projectId}`,
    })

    await recordAudit({
      req,
      action: 'manager.assigned',
      entityType: 'ManagerAssignment',
      entityId: projectId,
      after: { managerId, projectId },
    })

    res.status(201).json({ data: assignment })
  },
)

managersRouter.delete(
  '/assignments/:managerId/:projectId',
  requirePermission(PERMISSIONS.MANAGER_WRITE),
  validate({
    params: z.object({ managerId: z.string().cuid(), projectId: z.string().cuid() }),
  }),
  async (req, res) => {
    const { managerId, projectId } = req.params as { managerId: string; projectId: string }

    const existing = await prisma.managerAssignment.findUnique({
      where: { managerId_projectId: { managerId, projectId } },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Manager assignment')

    await prisma.managerAssignment.delete({ where: { id: existing.id } })
    await recordAudit({
      req,
      action: 'manager.unassigned',
      entityType: 'ManagerAssignment',
      entityId: projectId,
      before: { managerId, projectId },
    })

    res.status(204).send()
  },
)

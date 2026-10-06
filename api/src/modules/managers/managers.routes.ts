import { Router } from 'express'
import { param } from '../../lib/http.js'
import { z } from 'zod'
import { Role, UserStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { searchTerms } from '../../lib/search.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { recordAudit } from '../../lib/audit.js'
import { BadRequestError, NotFoundError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { createNotification } from '../notifications/notifications.service.js'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * §2.2 "Manager Management" — internal managers and Sub-Admins overseeing
 * projects. A manager is not a separate account type: it is an ADMIN or
 * SUB_ADMIN user linked to one or more projects.
 */
export const managersRouter = Router()

managersRouter.use(authenticate)
managersRouter.use(requirePermission(PERMISSIONS.MANAGER_READ))

const MANAGER_SORT_FIELDS = [
  'createdAt',
  'firstName',
  'lastName',
  'email',
  'role',
  'status',
] as const

const listQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
  status: z.nativeEnum(UserStatus).optional(),
})

/** Everyone eligible to manage a project, with their current load. */
managersRouter.get('/', validate({ query: listQuery }), async (_req, res) => {
  const query = validatedQuery<z.infer<typeof listQuery>>(res)

  const where = {
    role: { in: [Role.ADMIN, Role.SUB_ADMIN] },
    // Archived managers are hidden by default, same as the Users list —
    // but, unlike Organisation's archive (which has no way back), explicitly
    // asking for ARCHIVED here still finds them.
    ...(query.status === UserStatus.ARCHIVED ? {} : { deletedAt: null }),
    ...(query.status ? { status: query.status } : {}),
    /** Every term must match some column — see `searchTerms`. */
    ...(searchTerms(query.search).length > 0
      ? {
          AND: searchTerms(query.search).map((term) => ({
            OR: [
              { email: { contains: term, mode: 'insensitive' as const } },
              { firstName: { contains: term, mode: 'insensitive' as const } },
              { lastName: { contains: term, mode: 'insensitive' as const } },
            ],
          })),
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

/**
 * Projects this manager could still be assigned to — deliberately every
 * non-deleted project on the platform, not `projectScope(req.user!)`'s view
 * of them.
 *
 * Those are two different questions. `projectScope` answers "which projects
 * can the CALLER browse", and for a Sub-Admin holding
 * `project.scope_to_assigned` that is only the projects *they themselves*
 * already manage — correct for the main Projects list, where that Sub-Admin
 * is looking at their own work. Here the caller is deciding which project
 * SOMEONE ELSE (the manager named in the URL) should pick up next, which is
 * exactly what `manager.read`/`manager.write` (already required on every
 * route in this file) exists to gate. Reusing the scoped list silently
 * capped this picker to the caller's own projects, so a scoped Sub-Admin
 * with manager.write could see "no more projects to assign" for a manager
 * who, in fact, had every platform project still available.
 */
managersRouter.get(
  '/:id/assignable-projects',
  validate({ params: z.object({ id: z.string().cuid() }) }),
  async (req, res) => {
    const managerId = param(req, 'id')
    const projects = await prisma.project.findMany({
      where: { deletedAt: null, managers: { none: { managerId } } },
      select: { id: true, reference: true, title: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    res.json({ data: projects })
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

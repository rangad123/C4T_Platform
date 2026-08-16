import { type Prisma, ProjectStatus, AssignmentStatus, OrgMemberRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { isAdminSide } from '../../middleware/authorize.js'
import { projectScope } from '../../lib/access/scopes.js'
import { projectRelations } from '../../lib/access/relations.js'
import { authorize, can } from '../../lib/access/policy.js'
import { assertAssignable } from '../testers/testers.service.js'
import { createNotification, createNotifications } from '../notifications/notifications.service.js'
import { nextReference } from '../../lib/reference.js'
import { PROJECT_SORT_FIELDS, type ListProjectsQuery } from './projects.schema.js'

const projectSelect = {
  id: true,
  reference: true,
  title: true,
  summary: true,
  status: true,
  priority: true,
  platformTargets: true,
  targetCountries: true,
  targetLanguages: true,
  maxTesters: true,
  testersCanSeeOtherBugs: true,
  startDate: true,
  endDate: true,
  submittedAt: true,
  approvedAt: true,
  completedAt: true,
  progressPercent: true,
  createdAt: true,
  updatedAt: true,
  organisation: { select: { id: true, name: true, slug: true, status: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
  _count: { select: { bugs: true, assignments: true, materials: true } },
} satisfies Prisma.ProjectSelect

/**
 * Valid status transitions (§2.2 Project Management).
 * Encoded rather than free-form so the Admin UI and the API agree, and so an
 * accidental jump from DRAFT straight to COMPLETED is impossible.
 */
const STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'PAUSED', 'CANCELLED'],
  IN_PROGRESS: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'], // reopening is allowed
  CANCELLED: [],
}

/**
 * Builds the WHERE clause that scopes a project query to what the caller may
 * see. This is the single place project visibility is decided:
 *   ADMIN / SUB_ADMIN — everything
 *   CUSTOMER          — projects belonging to their organisations
 *   TESTER            — only projects they are assigned to
 */
/**
 * Kept as a named export because stats and communication both compose it into
 * their own queries. The implementation now lives in lib/access/scopes.ts so
 * there is exactly one definition of project visibility in the codebase.
 */
export const visibilityFilter = projectScope

export async function assertProjectAccess(
  user: Express.AuthenticatedUser,
  projectId: string,
): Promise<void> {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
}

export async function listProjects(user: Express.AuthenticatedUser, query: ListProjectsQuery) {
  const where: Prisma.ProjectWhereInput = {
    deletedAt: null,
    ...visibilityFilter(user),
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.organisationId ? { organisationId: query.organisationId } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { reference: { contains: query.search, mode: 'insensitive' } },
            { summary: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.project.findMany({
      where,
      select: projectSelect,
      orderBy: buildOrderBy(query.sort, query.order, PROJECT_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.project.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

/**
 * CSV export of the same row set the list endpoint returns, minus pagination.
 * Reuses the exact `where` clause from `listProjects` so the access scope and
 * filters are identical — exporting never bypasses RBAC.
 */
export async function exportProjectsCSV(
  user: Express.AuthenticatedUser,
  query: ListProjectsQuery,
): Promise<string> {
  const where: Prisma.ProjectWhereInput = {
    deletedAt: null,
    ...visibilityFilter(user),
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.organisationId ? { organisationId: query.organisationId } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { reference: { contains: query.search, mode: 'insensitive' } },
            { summary: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const items = await prisma.project.findMany({
    where,
    select: projectSelect,
    orderBy: buildOrderBy(query.sort, query.order, PROJECT_SORT_FIELDS, 'createdAt'),
  })

  const rows = items.map((p) => [
    p.reference,
    p.title,
    p.status,
    p.priority,
    p.organisation?.name ?? '',
    [p.createdBy?.firstName, p.createdBy?.lastName].filter(Boolean).join(' '),
    p.platformTargets.join('|'),
    Array.isArray(p.targetCountries) ? p.targetCountries.join('|') : '',
    p.maxTesters ?? '',
    p.startDate,
    p.endDate,
    p.progressPercent,
    p._count.bugs,
    p._count.assignments,
    p.createdAt,
    p.updatedAt,
  ])

  const { toCsv } = await import('../../lib/csv.js')
  return toCsv(
    [
      'Reference',
      'Title',
      'Status',
      'Priority',
      'Organisation',
      'Created by',
      'Platforms',
      'Countries',
      'Max testers',
      'Start date',
      'End date',
      'Progress %',
      'Bugs',
      'Testers',
      'Created at',
      'Updated at',
    ],
    rows,
  )
}

/**
 * Project detail, shaped by the caller's relationship to it.
 *
 * Three separate decisions, each its own policy action rather than a role check:
 *
 *   project.read_brief    the instructions and materials. An INVITED tester is
 *                         excluded — enough to decide, not the confidential scope.
 *   project.read_team     who else is working on it. Testers never see each other.
 *   project.read_contacts named people to raise a question with. An active
 *                         tester gets names and roles, never billing detail.
 */
export async function getProject(user: Express.AuthenticatedUser, id: string) {
  const resolved = await projectRelations(user, id)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }

  const { relations } = resolved
  const seesBrief = can(user, 'project.read_brief', relations)
  const seesTeam = can(user, 'project.read_team', relations)
  const seesContacts = can(user, 'project.read_contacts', relations)

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...projectSelect,
      instructions: true,
      materials: {
        select: {
          id: true,
          title: true,
          description: true,
          url: true,
          fileId: true,
          createdAt: true,
          file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
        },
      },
      assignments: {
        select: {
          status: true,
          invitedAt: true,
          respondedAt: true,
          completedAt: true,
          notes: true,
          tester: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              testerProfile: { select: { id: true, ratingAverage: true, countryCode: true } },
            },
          },
        },
      },
      managers: {
        select: {
          assignedAt: true,
          manager: {
            select: { id: true, firstName: true, lastName: true, email: true, role: true },
          },
        },
      },
    },
  })

  if (!project) throw new NotFoundError('Project')

  const myAssignment = project.assignments.find((a) => a.tester.id === user.id)

  const contacts = seesContacts
    ? await projectContacts(id, project.organisation.id, {
        // A tester gets names and roles so they know who to ask; the customer
        // side gets email addresses too.
        includeEmail: seesTeam,
      })
    : []

  return {
    ...project,
    instructions: seesBrief ? project.instructions : null,
    materials: seesBrief ? project.materials : [],
    // A tester sees only their own assignment row, never the rest of the crowd.
    assignments: seesTeam ? project.assignments : myAssignment ? [myAssignment] : [],
    managers: seesTeam ? project.managers : [],
    contacts,
    capabilities: {
      canReadBrief: seesBrief,
      canUpdate: can(user, 'project.update', relations),
      canChangeStatus: can(user, 'project.change_status', relations),
      canAssignTesters: can(user, 'project.assign_testers', relations),
      canManageMaterials: can(user, 'project.manage_materials', relations),
      canReportBug: can(user, 'bug.create', relations),
      myAssignmentStatus: myAssignment?.status ?? null,
    },
  }
}

/**
 * Named people an assigned tester can legitimately reach: the organisation's
 * owners and the project's managers. Not the full member list, and never the
 * organisation's billing or account profile.
 */
async function projectContacts(
  projectId: string,
  organisationId: string,
  options: { includeEmail: boolean },
) {
  const [owners, managers] = await Promise.all([
    prisma.organisationMember.findMany({
      where: { organisationId, orgRole: OrgMemberRole.OWNER },
      select: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
      },
    }),
    prisma.managerAssignment.findMany({
      where: { projectId },
      select: {
        manager: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
      },
    }),
  ])

  const shape = (
    person: { id: string; firstName: string | null; lastName: string | null; email: string },
    kind: 'customer' | 'manager',
  ) => ({
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    kind,
    ...(options.includeEmail ? { email: person.email } : {}),
  })

  return [
    ...owners.map((o) => shape(o.user, 'customer' as const)),
    ...managers.map((m) => shape(m.manager, 'manager' as const)),
  ]
}

/** Resolves which organisation a new project belongs to, and checks the caller may use it. */
async function resolveOrganisationId(
  user: Express.AuthenticatedUser,
  requested?: string,
): Promise<string> {
  if (isAdminSide(user)) {
    if (!requested) throw new BadRequestError('organisationId is required')
    const org = await prisma.organisation.findFirst({
      where: { id: requested, deletedAt: null },
      select: { id: true },
    })
    if (!org) throw new BadRequestError('Organisation does not exist')
    return org.id
  }

  const memberships = await prisma.organisationMember.findMany({
    where: { userId: user.id, organisation: { deletedAt: null } },
    select: { organisationId: true },
  })
  if (memberships.length === 0) {
    throw new ForbiddenError('You do not belong to an organisation')
  }
  if (requested) {
    if (!memberships.some((m) => m.organisationId === requested)) {
      throw new ForbiddenError('You do not belong to that organisation')
    }
    return requested
  }
  if (memberships.length > 1) {
    throw new BadRequestError('You belong to several organisations — specify organisationId')
  }
  return memberships[0]!.organisationId
}

export async function createProject(
  user: Express.AuthenticatedUser,
  input: Record<string, unknown> & { organisationId?: string },
) {
  const organisationId = await resolveOrganisationId(user, input.organisationId)
  const { organisationId: _drop, ...data } = input

  const project = await prisma.project.create({
    data: {
      ...(data as Prisma.ProjectCreateInput),
      reference: await nextReference('project'),
      organisation: { connect: { id: organisationId } },
      createdBy: { connect: { id: user.id } },
      status: ProjectStatus.DRAFT,
    },
    select: projectSelect,
  })

  return project
}

export async function updateProject(
  user: Express.AuthenticatedUser,
  id: string,
  input: Record<string, unknown>,
) {
  const resolved = await projectRelations(user, id)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.update', resolved.relations)

  const { relations, project } = resolved
  const isPlatformSide =
    relations.has('platform:admin') ||
    relations.has('platform:subadmin') ||
    relations.has('project:manager')

  // A customer may only reshape the project while it is still a draft.
  if (!isPlatformSide) {
    if (project.status !== ProjectStatus.DRAFT && project.status !== ProjectStatus.SUBMITTED) {
      throw new ForbiddenError(
        'This project can no longer be edited. Contact your account manager.',
      )
    }
    // progressPercent is maintained by the delivery team, not the customer.
    delete input.progressPercent
  }

  return prisma.project.update({
    where: { id },
    data: input,
    select: projectSelect,
  })
}

export async function changeStatus(
  user: Express.AuthenticatedUser,
  id: string,
  status: ProjectStatus,
) {
  const resolved = await projectRelations(user, id)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.change_status', resolved.relations)

  const { relations } = resolved
  const project = await prisma.project.findFirstOrThrow({
    where: { id, deletedAt: null },
    select: { id: true, status: true, title: true, organisationId: true },
  })

  const allowed = STATUS_TRANSITIONS[project.status]
  if (!allowed.includes(status)) {
    throw new ConflictError(
      `Cannot move a project from ${project.status} to ${status}. Allowed: ${allowed.join(', ') || 'none'}`,
    )
  }

  // A customer may submit their own draft. Everything past that is the
  // delivery team's call — approving your own project would be meaningless.
  const isPlatformSide =
    relations.has('platform:admin') ||
    relations.has('platform:subadmin') ||
    relations.has('project:manager')

  if (!isPlatformSide) {
    const customerMaySubmit =
      project.status === ProjectStatus.DRAFT && status === ProjectStatus.SUBMITTED
    if (!customerMaySubmit) {
      throw new ForbiddenError('Only the delivery team can make that status change')
    }
  }

  const updated = await prisma.project.update({
    where: { id },
    data: {
      status,
      ...(status === ProjectStatus.SUBMITTED ? { submittedAt: new Date() } : {}),
      ...(status === ProjectStatus.APPROVED ? { approvedAt: new Date() } : {}),
      // Reopening a completed project — clear `completedAt` so the column
      // is honest. `progressPercent` is also reset so the timeline
      // indicator in the admin UI does not stay pinned at 100.
      ...(project.status === ProjectStatus.COMPLETED && status !== ProjectStatus.COMPLETED
        ? { completedAt: null, progressPercent: null }
        : {}),
      ...(status === ProjectStatus.COMPLETED
        ? { completedAt: new Date(), progressPercent: 100 }
        : {}),
    } as Prisma.ProjectUncheckedUpdateInput,
    select: projectSelect,
  })

  // Tell the assigned testers and the customer's owners.
  const [assignments, owners] = await Promise.all([
    prisma.projectAssignment.findMany({
      where: {
        projectId: id,
        status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE] },
      },
      select: { testerId: true },
    }),
    prisma.organisationMember.findMany({
      where: { organisationId: project.organisationId, orgRole: OrgMemberRole.OWNER },
      select: { userId: true },
    }),
  ])

  await createNotifications(
    [...assignments.map((a) => a.testerId), ...owners.map((o) => o.userId)],
    {
      type: 'PROJECT_STATUS_CHANGED',
      title: `Project "${project.title}" is now ${status.toLowerCase().replace('_', ' ')}`,
      link: `/app/projects/${id}`,
    },
  )

  return updated
}

export async function archiveProject(id: string) {
  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  })
  if (!project) throw new NotFoundError('Project')

  return prisma.project.update({
    where: { id },
    data: { deletedAt: new Date(), status: ProjectStatus.CANCELLED },
    select: { id: true, status: true, deletedAt: true },
  })
}

// ─── Materials (§2.3 "testing instructions, scope, and materials") ───────────

export async function addMaterial(
  user: Express.AuthenticatedUser,
  projectId: string,
  input: { title: string; description?: string; fileId?: string; url?: string },
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  return prisma.projectMaterial.create({
    data: {
      projectId,
      title: input.title,
      description: input.description ?? null,
      fileId: input.fileId ?? null,
      url: input.url ?? null,
    },
  })
}

export async function removeMaterial(
  user: Express.AuthenticatedUser,
  projectId: string,
  materialId: string,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  const material = await prisma.projectMaterial.findFirst({
    where: { id: materialId, projectId },
    select: { id: true },
  })
  if (!material) throw new NotFoundError('Material')

  await prisma.projectMaterial.delete({ where: { id: materialId } })
}

// ─── Features (§2.2 Build Settings "Feature Lists") ──────────────────────────

export async function listFeatures(user: Express.AuthenticatedUser, projectId: string) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  return prisma.feature.findMany({
    where: { projectId },
    select: { id: true, name: true, createdAt: true, _count: { select: { bugs: true } } },
    orderBy: { name: 'asc' },
  })
}

export async function addFeature(user: Express.AuthenticatedUser, projectId: string, name: string) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  const existing = await prisma.feature.findUnique({
    where: { projectId_name: { projectId, name } },
    select: { id: true },
  })
  if (existing) throw new ConflictError('A feature with this name already exists on this project')

  return prisma.feature.create({
    data: { projectId, name },
    select: { id: true, name: true, createdAt: true },
  })
}

export async function removeFeature(
  user: Express.AuthenticatedUser,
  projectId: string,
  featureId: string,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  const feature = await prisma.feature.findFirst({
    where: { id: featureId, projectId },
    select: { id: true },
  })
  if (!feature) throw new NotFoundError('Feature')

  // Bugs tagged with this feature keep their bug — `featureId` just goes null
  // (onDelete: SetNull on Bug.feature) rather than losing the report.
  await prisma.feature.delete({ where: { id: featureId } })
}

// ─── Assignments (§2.2 Project Management → assign testers) ──────────────────

export async function assignTesters(projectId: string, testerIds: string[], notes?: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, title: true, status: true, maxTesters: true },
  })
  if (!project) throw new NotFoundError('Project')
  if (project.status === ProjectStatus.CANCELLED || project.status === ProjectStatus.COMPLETED) {
    throw new ConflictError('Cannot assign testers to a closed project')
  }

  // Validate every tester before writing any of them, so a partial batch never
  // half-applies.
  const unique = [...new Set(testerIds)]
  for (const testerId of unique) {
    await assertAssignable(testerId)
  }

  const existing = await prisma.projectAssignment.findMany({
    where: { projectId, testerId: { in: unique } },
    select: { testerId: true },
  })
  const alreadyAssigned = new Set(existing.map((e) => e.testerId))
  const toCreate = unique.filter((id) => !alreadyAssigned.has(id))

  if (project.maxTesters !== null && toCreate.length > 0) {
    // REMOVED/DECLINED testers freed up their slot; everything else still
    // occupies one.
    const currentlyOnRoster = await prisma.projectAssignment.count({
      where: {
        projectId,
        status: { notIn: [AssignmentStatus.REMOVED, AssignmentStatus.DECLINED] },
      },
    })
    const remaining = project.maxTesters - currentlyOnRoster
    if (remaining <= 0) {
      throw new ConflictError(
        `This project is already at its limit of ${project.maxTesters} tester${project.maxTesters === 1 ? '' : 's'}.`,
      )
    }
    if (toCreate.length > remaining) {
      throw new ConflictError(
        `Only ${remaining} more tester${remaining === 1 ? '' : 's'} can be added — this project is capped at ${project.maxTesters}.`,
      )
    }
  }

  if (toCreate.length > 0) {
    await prisma.projectAssignment.createMany({
      data: toCreate.map((testerId) => ({
        projectId,
        testerId,
        status: AssignmentStatus.INVITED,
        notes: notes ?? null,
      })),
    })

    await createNotifications(toCreate, {
      type: 'PROJECT_ASSIGNED',
      title: `You have been invited to test "${project.title}"`,
      body: notes,
      link: `/app/tester/projects/${projectId}`,
    })
  }

  return {
    invited: toCreate.length,
    skipped: unique.length - toCreate.length,
    assignments: await prisma.projectAssignment.findMany({
      where: { projectId },
      select: {
        status: true,
        invitedAt: true,
        respondedAt: true,
        tester: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    }),
  }
}

/** §2.3 — a tester accepts or declines their invitation. */
export async function respondToAssignment(
  testerId: string,
  projectId: string,
  response: 'ACCEPTED' | 'DECLINED',
  notes?: string,
) {
  const assignment = await prisma.projectAssignment.findUnique({
    where: { projectId_testerId: { projectId, testerId } },
    select: { id: true, status: true, project: { select: { title: true, createdById: true } } },
  })
  if (!assignment) throw new NotFoundError('Assignment')
  if (assignment.status !== AssignmentStatus.INVITED) {
    throw new ConflictError(`You have already responded to this invitation (${assignment.status})`)
  }

  const updated = await prisma.projectAssignment.update({
    where: { id: assignment.id },
    data: {
      status: response,
      respondedAt: new Date(),
      ...(notes ? { notes } : {}),
    },
  })

  await createNotification({
    userId: assignment.project.createdById,
    type: 'PROJECT_ASSIGNED',
    title: `A tester ${response === AssignmentStatus.ACCEPTED ? 'accepted' : 'declined'} "${assignment.project.title}"`,
    link: `/app/projects/${projectId}`,
  })

  return updated
}

/** Admin-side change to an assignment: activate, complete or remove a tester. */
export async function updateAssignment(
  projectId: string,
  testerId: string,
  status: AssignmentStatus,
  notes?: string,
) {
  const assignment = await prisma.projectAssignment.findUnique({
    where: { projectId_testerId: { projectId, testerId } },
    select: { id: true },
  })
  if (!assignment) throw new NotFoundError('Assignment')

  return prisma.projectAssignment.update({
    where: { id: assignment.id },
    data: {
      status,
      ...(notes ? { notes } : {}),
      ...(status === AssignmentStatus.COMPLETED ? { completedAt: new Date() } : {}),
      ...(status === AssignmentStatus.REMOVED ? { removedAt: new Date() } : {}),
    },
  })
}

/** §2.3 — projects available to, or assigned to, the calling tester. */
export async function listMyAssignments(
  testerId: string,
  query: { page: number; limit: number; status?: AssignmentStatus },
) {
  const where: Prisma.ProjectAssignmentWhereInput = {
    testerId,
    project: { deletedAt: null },
    ...(query.status ? { status: query.status } : {}),
  }

  const [items, total] = await Promise.all([
    prisma.projectAssignment.findMany({
      where,
      select: {
        status: true,
        invitedAt: true,
        respondedAt: true,
        completedAt: true,
        notes: true,
        project: {
          select: {
            id: true,
            reference: true,
            title: true,
            summary: true,
            status: true,
            priority: true,
            startDate: true,
            endDate: true,
            platformTargets: true,
            organisation: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { invitedAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.projectAssignment.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

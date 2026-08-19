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

/** The compact shape nested inside a project read — the build switcher only needs this much. */
const buildSummarySelect = {
  id: true,
  name: true,
  isDefault: true,
  createdAt: true,
} satisfies Prisma.BuildSelect

/** The full shape for Build Details / Edit Build — every field §6 of the brief asks for. */
const buildSelect = {
  id: true,
  projectId: true,
  name: true,
  isDefault: true,
  status: true,
  testType: true,
  description: true,
  appUrl: true,
  releaseNotes: true,
  instructions: true,
  specialRequirements: true,
  targetDevices: true,
  targetBrowsers: true,
  targetOperatingSystems: true,
  targetCountries: true,
  targetLanguages: true,
  maxTesters: true,
  testersCanSeeOtherBugs: true,
  startDate: true,
  endDate: true,
  testDocumentFileId: true,
  testDocument: {
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
  },
  createdAt: true,
  updatedAt: true,
  _count: { select: { assignments: true, bugs: true, materials: true, features: true, testCases: true } },
} satisfies Prisma.BuildSelect

/**
 * Resolves which build a read or write should be scoped to.
 *
 * `requested` is untrusted input (a query param or a form field) — it must
 * belong to `projectId` or it is rejected outright, so one project's build id
 * can never be used to reach into another project's rows. Omitting it falls
 * back to the project's `isDefault` build, which is what makes every
 * existing caller that has never heard of builds (the tester portal, an
 * older integration) keep working unchanged after this migration.
 *
 * Exported for `bugs.service.ts`'s `createBug` — one build-resolution rule,
 * not two.
 */
export async function resolveBuildId(projectId: string, requested?: string | null): Promise<string> {
  if (requested) {
    const build = await prisma.build.findFirst({
      where: { id: requested, projectId, deletedAt: null },
      select: { id: true },
    })
    if (!build) throw new BadRequestError('That build does not belong to this project')
    return build.id
  }

  const fallback = await prisma.build.findFirst({
    where: { projectId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  })
  // Every project gets its default build at creation time (see `createProject`)
  // — reaching this means the data is in a state the app never produces.
  if (!fallback) throw new NotFoundError('Build')
  return fallback.id
}

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
    ...(query.testerId ? { assignments: { some: { testerId: query.testerId } } } : {}),
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
    ...(query.testerId ? { assignments: { some: { testerId: query.testerId } } } : {}),
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
export async function getProject(
  user: Express.AuthenticatedUser,
  id: string,
  requestedBuildId?: string,
) {
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
      builds: {
        where: { deletedAt: null },
        select: buildSummarySelect,
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      },
      materials: {
        select: {
          id: true,
          buildId: true,
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
          buildId: true,
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

  // Fetched unscoped by build (Prisma can't apply a build filter here AND
  // still let the tester branch below fall back to "whichever build my own
  // assignment is on") and filtered in JS instead, per branch, right below.
  const myAssignment = project.assignments.find((a) => a.tester.id === user.id)

  // The build switcher is an admin/manager/customer affordance — a tester has
  // no concept of "the active build," only of their own single assignment, so
  // their effective build is whichever one that assignment was made under,
  // never a `?buildId=` they never had a UI to set.
  const activeBuildId = seesTeam
    ? await resolveBuildId(id, requestedBuildId)
    : (myAssignment?.buildId ?? (await resolveBuildId(id)))

  const contacts = seesContacts
    ? await projectContacts(id, project.organisation.id, {
        // A tester gets names and roles so they know who to ask; the customer
        // side gets email addresses too.
        includeEmail: seesTeam,
      })
    : []

  return {
    ...project,
    activeBuildId,
    instructions: seesBrief ? project.instructions : null,
    materials: seesBrief ? project.materials.filter((m) => m.buildId === activeBuildId) : [],
    // A tester sees only their own assignment row, never the rest of the
    // crowd — and never filtered by build, since it is their one row
    // regardless of which build it belongs to.
    assignments: seesTeam
      ? project.assignments.filter((a) => a.buildId === activeBuildId)
      : myAssignment
        ? [myAssignment]
        : [],
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
      // Every project gets one build the moment it exists, so a caller that
      // never opens the build switcher (the tester portal, a bug report, an
      // older integration) always has a `buildId` to fall back to.
      builds: { create: { name: 'Original build', isDefault: true } },
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
  input: { title: string; description?: string; fileId?: string; url?: string; buildId?: string },
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  const buildId = await resolveBuildId(projectId, input.buildId)

  return prisma.projectMaterial.create({
    data: {
      projectId,
      buildId,
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

export async function listFeatures(
  user: Express.AuthenticatedUser,
  projectId: string,
  requestedBuildId?: string,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  const buildId = await resolveBuildId(projectId, requestedBuildId)
  return prisma.feature.findMany({
    where: { projectId, buildId },
    select: { id: true, name: true, createdAt: true, _count: { select: { bugs: true } } },
    orderBy: { name: 'asc' },
  })
}

export async function addFeature(
  user: Express.AuthenticatedUser,
  projectId: string,
  name: string,
  requestedBuildId?: string,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  const buildId = await resolveBuildId(projectId, requestedBuildId)

  const existing = await prisma.feature.findUnique({
    where: { buildId_name: { buildId, name } },
    select: { id: true },
  })
  if (existing) throw new ConflictError('A feature with this name already exists on this build')

  return prisma.feature.create({
    data: { projectId, buildId, name },
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

export async function assignTesters(
  projectId: string,
  testerIds: string[],
  notes?: string,
  requestedBuildId?: string,
) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, title: true, status: true, maxTesters: true },
  })
  if (!project) throw new NotFoundError('Project')
  if (project.status === ProjectStatus.CANCELLED || project.status === ProjectStatus.COMPLETED) {
    throw new ConflictError('Cannot assign testers to a closed project')
  }

  const buildId = await resolveBuildId(projectId, requestedBuildId)

  // Validate every tester before writing any of them, so a partial batch never
  // half-applies.
  const unique = [...new Set(testerIds)]
  for (const testerId of unique) {
    await assertAssignable(testerId)
  }

  // A tester keeps exactly one roster row per PROJECT, not per build (see the
  // schema comment on `ProjectAssignment.buildId`) — so someone already on
  // the roster under a different build is skipped here, the same as someone
  // already invited under this one. Moving a tester between builds is not
  // exposed by this endpoint.
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
        buildId,
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

// ─── Builds (§6-9 of the platform UX brief — a project may span several) ─────
//
// Build management rides on `project.update` — the same permission that gates
// "Edit the brief" — because adding, renaming or retiring a build reshapes
// the project's own structure, not its testers/materials/bugs content.

export async function listBuilds(user: Express.AuthenticatedUser, projectId: string) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  return prisma.build.findMany({
    where: { projectId, deletedAt: null },
    select: buildSelect,
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
}

export async function getBuild(user: Express.AuthenticatedUser, projectId: string, buildId: string) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  const build = await prisma.build.findFirst({
    where: { id: buildId, projectId, deletedAt: null },
    select: buildSelect,
  })
  if (!build) throw new NotFoundError('Build')
  return { ...build, capabilities: { canUpdate: can(user, 'project.update', resolved.relations) } }
}

export async function createBuild(user: Express.AuthenticatedUser, projectId: string, name: string) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.update', resolved.relations)

  const existing = await prisma.build.findFirst({
    where: { projectId, name, deletedAt: null },
    select: { id: true },
  })
  if (existing) throw new ConflictError('A build with this name already exists on this project')

  return prisma.build.create({
    data: { projectId, name },
    select: buildSelect,
  })
}

/**
 * Full Build Details edit — name plus every field §6 of the platform UX
 * brief lists (test type, dates, app URL, test document, countries,
 * OS/browsers, instructions, special requirements, bug visibility, max
 * testers). `input` is whatever subset of those the caller sent; only a
 * rename touches the uniqueness check.
 */
export async function updateBuild(
  user: Express.AuthenticatedUser,
  projectId: string,
  buildId: string,
  input: Record<string, unknown> & { name?: string },
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.update', resolved.relations)

  const build = await prisma.build.findFirst({
    where: { id: buildId, projectId, deletedAt: null },
    select: { id: true },
  })
  if (!build) throw new NotFoundError('Build')

  if (input.name) {
    const clash = await prisma.build.findFirst({
      where: { projectId, name: input.name, deletedAt: null, id: { not: buildId } },
      select: { id: true },
    })
    if (clash) throw new ConflictError('A build with this name already exists on this project')
  }

  return prisma.build.update({ where: { id: buildId }, data: input, select: buildSelect })
}

/**
 * Duplicate a build's own configuration onto a new build of the same
 * project — §7 "Copy Build". Copies the descriptive fields (test type,
 * dates, targets, instructions, …) and the Feature list, since those define
 * what the NEW build tests. Deliberately does NOT copy testers, bugs,
 * materials, test cases/reports/reviews or payment records — those are
 * history that belongs to the build that produced them, not a template to
 * hand the copy a head start on.
 */
export async function copyBuild(user: Express.AuthenticatedUser, projectId: string, buildId: string) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.update', resolved.relations)

  const source = await prisma.build.findFirst({
    where: { id: buildId, projectId, deletedAt: null },
    select: buildSelect,
  })
  if (!source) throw new NotFoundError('Build')

  const existingNames = new Set(
    (
      await prisma.build.findMany({ where: { projectId, deletedAt: null }, select: { name: true } })
    ).map((b) => b.name),
  )
  let name = `${source.name} (copy)`
  let suffix = 2
  while (existingNames.has(name)) {
    name = `${source.name} (copy ${suffix})`
    suffix += 1
  }

  const copy = await prisma.build.create({
    data: {
      projectId,
      name,
      isDefault: false,
      status: 'NEW',
      testType: source.testType,
      description: source.description,
      appUrl: source.appUrl,
      releaseNotes: source.releaseNotes,
      instructions: source.instructions,
      specialRequirements: source.specialRequirements,
      targetDevices: source.targetDevices,
      targetBrowsers: source.targetBrowsers,
      targetOperatingSystems: source.targetOperatingSystems,
      targetCountries: source.targetCountries,
      targetLanguages: source.targetLanguages,
      maxTesters: source.maxTesters,
      testersCanSeeOtherBugs: source.testersCanSeeOtherBugs,
      testDocumentFileId: source.testDocumentFileId,
    },
    select: buildSelect,
  })

  const features = await prisma.feature.findMany({ where: { buildId }, select: { name: true } })
  if (features.length === 0) return copy

  await prisma.feature.createMany({
    data: features.map((f) => ({ projectId, buildId: copy.id, name: f.name })),
  })
  // `copy`'s `_count.features` was snapshotted before the createMany above —
  // re-read so the response the caller sees matches what actually happened.
  return prisma.build.findUniqueOrThrow({ where: { id: copy.id }, select: buildSelect })
}

/**
 * Soft-delete a build. Refused for the default build, and refused for the
 * last remaining one — every project must always have somewhere for its
 * testers/materials/features/bugs to point, and the default build is what
 * every build-unaware caller falls back to.
 */
export async function archiveBuild(
  user: Express.AuthenticatedUser,
  projectId: string,
  buildId: string,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.update', resolved.relations)

  const build = await prisma.build.findFirst({
    where: { id: buildId, projectId, deletedAt: null },
    select: { id: true, isDefault: true },
  })
  if (!build) throw new NotFoundError('Build')
  if (build.isDefault) throw new ConflictError('The default build cannot be removed')

  const remaining = await prisma.build.count({ where: { projectId, deletedAt: null } })
  if (remaining <= 1) throw new ConflictError('A project must keep at least one build')

  return prisma.build.update({
    where: { id: buildId },
    data: { deletedAt: new Date() },
    select: { id: true, deletedAt: true },
  })
}

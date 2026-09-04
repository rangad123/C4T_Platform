import {
  type Prisma,
  ProjectStatus,
  AssignmentStatus,
  OrgMemberRole,
  BugFieldType,
} from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { isAdminSide } from '../../middleware/authorize.js'
import { projectScope } from '../../lib/access/scopes.js'
import { projectRelations } from '../../lib/access/relations.js'
import { authorize, can } from '../../lib/access/policy.js'
import { assertAssignable, ACCEPTED_BUG_STATUSES } from '../testers/testers.service.js'
import { createNotification, createNotifications } from '../notifications/notifications.service.js'
import { nextReference } from '../../lib/reference.js'
import { PROJECT_SORT_FIELDS, type ListProjectsQuery } from './projects.schema.js'

/** Statuses that let a tester actually work a build — file bugs, see it as "active". */
const ACTIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.ACCEPTED,
  AssignmentStatus.ACTIVE,
]

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
  logoFileId: true,
  logo: { select: { id: true, originalName: true, mimeType: true } },
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
  bugCustomizationEnabled: true,
  testDocumentFileId: true,
  testDocument: {
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
  },
  createdAt: true,
  updatedAt: true,
  _count: {
    select: { assignments: true, bugs: true, materials: true, features: true, testCases: true },
  },
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
export async function resolveBuildId(
  projectId: string,
  requested?: string | null,
): Promise<string> {
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
 * The statuses in which testing is actually running, so bugs may be filed.
 *
 * This started as a deny-list that refused DRAFT, COMPLETED and CANCELLED,
 * which left two holes: PAUSED took reports despite being deliberately
 * halted, and SUBMITTED took reports against scope nobody had agreed to yet.
 * Stated as an allow-list instead, both close, and a status added to the enum
 * later is closed until someone decides otherwise.
 *
 * APPROVED is deliberately included: scope is agreed and the delivery team
 * onboards testers there before flipping to IN_PROGRESS.
 *
 * This is NOT the rule for adding testers to the roster — see
 * `OPEN_FOR_ROSTERING`, which is wider on purpose. Sharing one list between
 * the two was a mistake: it made a draft project impossible to staff.
 */
const OPEN_FOR_WORK: readonly ProjectStatus[] = [ProjectStatus.APPROVED, ProjectStatus.IN_PROGRESS]

/**
 * The statuses in which a project can still take testers onto its roster.
 *
 * Deliberately wider than `OPEN_FOR_WORK`, because building the crowd and
 * doing the testing are not the same act. Lining testers up while the scope
 * is still being written is normal — they are invited, they accept, and the
 * work starts when the project goes live. Refusing that made a draft project
 * impossible to staff, which is the wrong end to fix.
 *
 * What stays refused is a project nobody should be joining any more: PAUSED,
 * because it has been deliberately halted; COMPLETED and CANCELLED, because
 * they are over. Still an allow-list, so a status added later is closed until
 * someone decides otherwise.
 */
const OPEN_FOR_ROSTERING: readonly ProjectStatus[] = [
  ProjectStatus.DRAFT,
  ProjectStatus.SUBMITTED,
  ProjectStatus.APPROVED,
  ProjectStatus.IN_PROGRESS,
]

/**
 * Whether a project is live enough to take testers and bug reports.
 *
 * Takes a plain string so callers holding a status off a `select` do not each
 * have to import the Prisma enum to ask.
 */
export function isProjectOpenForWork(status: string): boolean {
  return (OPEN_FOR_WORK as readonly string[]).includes(status)
}

/** Whether testers can still be added to this project's roster. */
export function isProjectOpenForRostering(status: string): boolean {
  return (OPEN_FOR_ROSTERING as readonly string[]).includes(status)
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
    ...(query.testerId
      ? {
          assignments: {
            some: {
              testerId: query.testerId,
              // Absent = "ever assigned", the work-history reading this filter
              // was built for. See `testerAssignmentStatus` in the schema.
              ...(query.testerAssignmentStatus?.length
                ? { status: { in: query.testerAssignmentStatus } }
                : {}),
            },
          },
        }
      : {}),
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

  /**
   * `_count.assignments` on `projectSelect` is a literal roster-row count —
   * left as-is, since "how many invitations exist" is a real number in its
   * own right. The "Testers" column on the list wants PEOPLE, though: a
   * tester on two builds of one project must count once there, matching
   * every other headcount on the platform. `groupBy` on both columns is a
   * distinct-pairs count with no `_count` needed — one row per person per
   * project, tallied in JS.
   */
  const projectIds = items.map((p) => p.id)
  const testerPairs = projectIds.length
    ? await prisma.projectAssignment.groupBy({
        by: ['projectId', 'testerId'],
        where: { projectId: { in: projectIds } },
      })
    : []
  const distinctTesterCountByProject = new Map<string, number>()
  for (const pair of testerPairs) {
    distinctTesterCountByProject.set(
      pair.projectId,
      (distinctTesterCountByProject.get(pair.projectId) ?? 0) + 1,
    )
  }

  return {
    items: items.map((p) => ({
      ...p,
      distinctTesterCount: distinctTesterCountByProject.get(p.id) ?? 0,
    })),
    meta: buildMeta(query, total),
  }
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
          /**
           * What this tester was asked to cover. Returned so the roster can
           * show it — a configuration written at invite time and never
           * displayed anywhere would be a column nobody can act on.
           */
          assignedDevice: {
            select: { id: true, type: true, manufacturer: true, model: true, osName: true },
          },
          assignedBrowser: {
            select: {
              id: true,
              browser: { select: { name: true } },
              browserVersion: { select: { version: true } },
            },
          },
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
  // still let the tester branch below choose among ALL of their own rows)
  // and filtered in JS instead, per branch, right below.
  const myAssignments = project.assignments.filter((a) => a.tester.id === user.id)

  // A tester can now hold a `ProjectAssignment` on more than one build of
  // this project, so — like admin/manager/customer — they DO have a real
  // "active build" choice, just constrained to builds they actually hold a
  // row on: an unrecognised or absent `?buildId=` falls back to their most
  // relevant row (an active one first, else a pending invitation, else
  // whatever they have), never to a build they aren't on.
  const activeBuildId = seesTeam
    ? await resolveBuildId(id, requestedBuildId)
    : myAssignments.length > 0
      ? (myAssignments.find((a) => a.buildId === requestedBuildId)?.buildId ??
        myAssignments.find((a) => ACTIVE_ASSIGNMENT_STATUSES.includes(a.status))?.buildId ??
        myAssignments.find((a) => a.status === AssignmentStatus.INVITED)?.buildId ??
        myAssignments[0]!.buildId)
      : await resolveBuildId(id)

  const myAssignment = myAssignments.find((a) => a.buildId === activeBuildId) ?? null

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
    /**
     * A tester sees only their OWN row for the active build, never the rest
     * of the crowd — matching `assignments`' shape for team-side callers,
     * which is likewise scoped to the active build's roster, not the whole
     * project's.
     *
     * The roster is stripped of tester email addresses for anyone who is not
     * admin-side. A customer needs to know WHO is on their build — name,
     * country, rating — but a direct address serves no purpose in the product
     * and lets a client contact the crowd off-platform. This mirrors
     * `projectContacts` below, which already gates email by audience for the
     * same reason, and the bug CSV export, which does the same.
     */
    assignments: (seesTeam
      ? project.assignments.filter((a) => a.buildId === activeBuildId)
      : myAssignment
        ? [myAssignment]
        : []
    ).map((a) => {
      if (isAdminSide(user)) return a
      // Omit the key rather than blanking it, so no caller can mistake an
      // empty string for a real address.
      const { email: _omit, ...tester } = a.tester
      return { ...a, tester }
    }),
    // Every build THIS tester holds a row on — project-wide, not just the
    // active one — so the frontend can render a build switcher (and a
    // pending-invitation banner per build) without a second round trip.
    // Empty for team-side callers, who already see every tester's build in
    // `assignments` above and have their own `builds` list to switch with.
    myAssignments: seesTeam
      ? []
      : myAssignments.map((a) => ({ buildId: a.buildId, status: a.status })),
    managers: seesTeam ? project.managers : [],
    contacts,
    capabilities: {
      canReadBrief: seesBrief,
      canUpdate: can(user, 'project.update', relations),
      canChangeStatus: can(user, 'project.change_status', relations),
      canAssignTesters: can(user, 'project.assign_testers', relations),
      canManageMaterials: can(user, 'project.manage_materials', relations),
      // Being active on SOME build grants the `bug.create` relation
      // project-wide (see `projectRelations`), but filing must still target
      // the build the tester is actually active on — the one selected here.
      canReportBug:
        can(user, 'bug.create', relations) &&
        myAssignment !== null &&
        ACTIVE_ASSIGNMENT_STATUSES.includes(myAssignment.status),
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

  /**
   * A logo that no longer resolves must not sink the whole project.
   *
   * `logoFileId` is a foreign key, so a stale or half-finished upload made
   * Postgres reject the INSERT, which surfaced as a flat "Malformed database
   * query" 400 — and the wizard turned that into "try again in a moment",
   * advice that could never work. Checking it here turns an opaque failure
   * into a sentence naming the one field at fault.
   */
  /**
   * The logo is attached through its RELATION, never as a scalar id.
   *
   * `logoFileId` is the column behind `logo`, and this create already uses
   * the relation form for organisation and createdBy — so Prisma types the
   * whole argument as `ProjectCreateInput`, where the scalar simply is not a
   * field. Spreading it in made Prisma reject the call as malformed, which
   * the error handler reported as "Malformed database query". The `as` cast
   * is what let it compile: it silenced the one check that would have caught
   * this at build time.
   *
   * The effect was that creating a project with a logo NEVER worked, and
   * said nothing useful about why.
   */
  const { logoFileId, ...rest } = data as Record<string, unknown> & { logoFileId?: unknown }
  const logoId = typeof logoFileId === 'string' && logoFileId.length > 0 ? logoFileId : null

  if (logoId) {
    const logo = await prisma.fileObject.findFirst({
      where: { id: logoId, isComplete: true },
      select: { id: true },
    })
    if (!logo) {
      throw new BadRequestError(
        'That logo upload could not be found. Upload it again, or continue without one.',
      )
    }
  }

  const project = await prisma.project.create({
    data: {
      ...(rest as Prisma.ProjectCreateInput),
      reference: await nextReference('project'),
      organisation: { connect: { id: organisationId } },
      createdBy: { connect: { id: user.id } },
      ...(logoId ? { logo: { connect: { id: logoId } } } : {}),
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

// ─── Custom bug fields (§37-39 of the client brief) ──────────────────────────

const customFieldSelect = {
  id: true,
  name: true,
  type: true,
  options: true,
  isRequired: true,
  position: true,
  createdAt: true,
  _count: { select: { values: true } },
} satisfies Prisma.BugCustomFieldSelect

/** Types whose answer is chosen from `options` rather than typed. */
const CHOICE_TYPES: BugFieldType[] = [
  BugFieldType.SELECT,
  BugFieldType.RADIO,
  BugFieldType.CHECKBOX,
]

/**
 * The extra questions this build's bug form asks.
 *
 * Readable by anyone who can read the project — a tester needs them to fill
 * the form in, the customer to read the answers back.
 */
export async function listBugCustomFields(
  user: Express.AuthenticatedUser,
  projectId: string,
  requestedBuildId?: string,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  const buildId = await resolveBuildId(projectId, requestedBuildId)
  return prisma.bugCustomField.findMany({
    where: { buildId },
    select: customFieldSelect,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })
}

export async function addBugCustomField(
  user: Express.AuthenticatedUser,
  projectId: string,
  input: {
    name: string
    type: BugFieldType
    options?: string[]
    isRequired?: boolean
    buildId?: string
  },
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  const buildId = await resolveBuildId(projectId, input.buildId)

  /**
   * A choice field with no options is a question a tester cannot answer, so
   * it is refused rather than stored. Conversely options on a free-text field
   * would never be rendered, so they are dropped rather than silently kept.
   */
  const isChoice = CHOICE_TYPES.includes(input.type)
  const options = isChoice ? (input.options ?? []).map((o) => o.trim()).filter(Boolean) : []
  if (isChoice && options.length === 0) {
    throw new BadRequestError('This field type needs at least one option')
  }
  if (new Set(options).size !== options.length) {
    throw new BadRequestError('Options must be different from each other')
  }

  const existing = await prisma.bugCustomField.findUnique({
    where: { buildId_name: { buildId, name: input.name } },
    select: { id: true },
  })
  if (existing) throw new ConflictError('A field with this name already exists on this build')

  // Append. `position` is only a render order, so the next integer is enough.
  const last = await prisma.bugCustomField.findFirst({
    where: { buildId },
    select: { position: true },
    orderBy: { position: 'desc' },
  })

  return prisma.bugCustomField.create({
    data: {
      buildId,
      name: input.name,
      type: input.type,
      options,
      isRequired: input.isRequired ?? false,
      position: (last?.position ?? -1) + 1,
    },
    select: customFieldSelect,
  })
}

/**
 * Removes a field definition.
 *
 * The answers go with it (`onDelete: Cascade` on `BugCustomValue.field`), and
 * that is the honest behaviour: a value has no meaning without the question,
 * and keeping orphaned strings would show up in reports as unlabelled data.
 * The count of affected answers is returned so the UI can warn first.
 */
export async function removeBugCustomField(
  user: Express.AuthenticatedUser,
  projectId: string,
  fieldId: string,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.manage_materials', resolved.relations)

  const field = await prisma.bugCustomField.findFirst({
    where: { id: fieldId, build: { projectId } },
    select: { id: true, _count: { select: { values: true } } },
  })
  if (!field) throw new NotFoundError('Field')

  await prisma.bugCustomField.delete({ where: { id: field.id } })
  return { id: field.id, removedAnswers: field._count.values }
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

export interface AssignmentConfiguration {
  testerId: string
  deviceId?: string | null
  browserId?: string | null
}

/**
 * Resolves what each tester was asked to cover, refusing anything they do not
 * own.
 *
 * THE OWNERSHIP CHECK IS THE POINT. `deviceId` and `browserId` arrive from a
 * client, and both tables are global — every tester's handsets live in
 * `tester_devices`. Writing them unchecked would let a crafted request pin
 * one tester's assignment to another tester's phone, which is both nonsense
 * on the roster and a quiet read of someone else's asset list.
 *
 * One query per table for the whole batch rather than per tester: a hundred
 * testers is one round trip, not two hundred.
 */
async function resolveAssignmentConfigurations(
  configurations: AssignmentConfiguration[] | undefined,
): Promise<Map<string, { deviceId: string | null; browserId: string | null }>> {
  const resolved = new Map<string, { deviceId: string | null; browserId: string | null }>()
  if (!configurations || configurations.length === 0) return resolved

  const deviceIds = configurations.map((c) => c.deviceId).filter((v): v is string => Boolean(v))
  const browserIds = configurations.map((c) => c.browserId).filter((v): v is string => Boolean(v))

  const [devices, browsers] = await Promise.all([
    deviceIds.length > 0
      ? prisma.testerDevice.findMany({
          where: { id: { in: deviceIds } },
          select: { id: true, testerProfile: { select: { userId: true } } },
        })
      : Promise.resolve([]),
    browserIds.length > 0
      ? prisma.testerBrowser.findMany({
          where: { id: { in: browserIds } },
          select: { id: true, testerProfile: { select: { userId: true } } },
        })
      : Promise.resolve([]),
  ])

  const deviceOwner = new Map(devices.map((d) => [d.id, d.testerProfile.userId]))
  const browserOwner = new Map(browsers.map((b) => [b.id, b.testerProfile.userId]))

  for (const config of configurations) {
    if (config.deviceId && deviceOwner.get(config.deviceId) !== config.testerId) {
      throw new BadRequestError('That device does not belong to the tester it was chosen for')
    }
    if (config.browserId && browserOwner.get(config.browserId) !== config.testerId) {
      throw new BadRequestError('That browser does not belong to the tester it was chosen for')
    }
    resolved.set(config.testerId, {
      deviceId: config.deviceId ?? null,
      browserId: config.browserId ?? null,
    })
  }

  return resolved
}

export async function assignTesters(
  projectId: string,
  testerIds: string[],
  notes?: string,
  requestedBuildId?: string,
  configurations?: AssignmentConfiguration[],
) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, title: true, status: true, maxTesters: true },
  })
  if (!project) throw new NotFoundError('Project')
  if (!isProjectOpenForWork(project.status)) {
    throw new ConflictError('Testers can only be assigned to a project that is approved or running')
  }

  const buildId = await resolveBuildId(projectId, requestedBuildId)

  // Validate every tester before writing any of them, so a partial batch never
  // half-applies.
  const unique = [...new Set(testerIds)]
  for (const testerId of unique) {
    await assertAssignable(testerId)
  }

  /**
   * A tester keeps one roster row per (project, BUILD) — see the schema
   * comment on `ProjectAssignment.buildId` — so someone already on THIS build
   * gets no second row, while someone on a different build of this project is
   * untouched: they can hold both.
   *
   * ── RE-INVITING SOMEONE WHO DECLINED OR WAS REMOVED
   *
   * Those two statuses are spent, not live: both are excluded from the
   * `maxTesters` count, and neither gives the tester any access. Until now
   * they were lumped in with "already assigned" and silently skipped, so a
   * tester who declined in error, or was taken off and needed back, could
   * never be invited again — the unique constraint forbids a second row and
   * nothing revived the first. Reviving is the only shape this can take.
   *
   * A live row (INVITED, ACCEPTED, ACTIVE, COMPLETED) is still skipped:
   * re-inviting someone who is already working on the build would reset
   * their standing for no reason.
   */
  const existing = await prisma.projectAssignment.findMany({
    where: { projectId, buildId, testerId: { in: unique } },
    select: { id: true, testerId: true, status: true },
  })

  const REVIVABLE: AssignmentStatus[] = [AssignmentStatus.DECLINED, AssignmentStatus.REMOVED]
  const revivable = existing.filter((e) => REVIVABLE.includes(e.status))
  const blocking = existing.filter((e) => !REVIVABLE.includes(e.status))

  const blocked = new Set(blocking.map((e) => e.testerId))
  const toRevive = revivable.filter((e) => unique.includes(e.testerId))
  const reviveIds = new Set(toRevive.map((e) => e.testerId))
  const toCreate = unique.filter((id) => !blocked.has(id) && !reviveIds.has(id))

  /** Everyone who ends up invited by this call, however they got there. */
  const invitedTesterIds = [...toCreate, ...toRevive.map((e) => e.testerId)]

  if (project.maxTesters !== null && invitedTesterIds.length > 0) {
    // Maximum testers counts PEOPLE on the project, not roster rows — a
    // tester already on one build who is now also being invited onto this
    // one does not consume a second seat. REMOVED/DECLINED testers freed up
    // their slot; everything else still occupies one.
    const currentlyOnRoster = await prisma.projectAssignment.findMany({
      where: {
        projectId,
        status: { notIn: [AssignmentStatus.REMOVED, AssignmentStatus.DECLINED] },
      },
      select: { testerId: true },
      distinct: ['testerId'],
    })
    const occupiedSeats = new Set(currentlyOnRoster.map((r) => r.testerId))
    /**
     * Only testers genuinely NEW to the project (not already occupying a seat
     * via a different build) draw down the remaining count.
     *
     * A revived tester counts here too, and must: DECLINED and REMOVED are
     * excluded from `occupiedSeats` above, so bringing one back re-occupies a
     * seat that the cap had already handed to someone else. Counting only
     * `toCreate` would let a project quietly exceed its own limit by reviving.
     */
    const newSeatsNeeded = invitedTesterIds.filter((id) => !occupiedSeats.has(id)).length
    const remaining = project.maxTesters - occupiedSeats.size
    // Guarded on `newSeatsNeeded > 0`: someone already occupying a seat
    // (via a different build) draws down nothing by joining another one,
    // even if the roster is already over cap for unrelated reasons — only a
    // genuinely NEW person can be refused here.
    if (newSeatsNeeded > 0 && newSeatsNeeded > remaining) {
      throw new ConflictError(
        remaining <= 0
          ? `This project is already at its limit of ${project.maxTesters} tester${project.maxTesters === 1 ? '' : 's'}.`
          : `Only ${remaining} more tester${remaining === 1 ? '' : 's'} can be added — this project is capped at ${project.maxTesters}.`,
      )
    }
  }

  /**
   * Resolved before the write, so a configuration naming someone else's
   * device fails the whole batch rather than inviting half of it and then
   * throwing — the same all-or-nothing the tester validation above gives.
   */
  const configured = await resolveAssignmentConfigurations(configurations)

  /**
   * Creating and reviving in one transaction.
   *
   * Both are the same act from the reader's side — "invite these people" —
   * so a batch that half-applies would leave a roster nobody asked for. The
   * notifications go out afterwards, outside the transaction, because a
   * notification failing is not a reason to un-invite anyone.
   */
  if (toCreate.length > 0 || toRevive.length > 0) {
    await prisma.$transaction([
      ...(toCreate.length > 0
        ? [
            prisma.projectAssignment.createMany({
              data: toCreate.map((testerId) => ({
                projectId,
                buildId,
                testerId,
                status: AssignmentStatus.INVITED,
                notes: notes ?? null,
                assignedDeviceId: configured.get(testerId)?.deviceId ?? null,
                assignedBrowserId: configured.get(testerId)?.browserId ?? null,
              })),
            }),
          ]
        : []),
      /**
       * A revival is a fresh invitation on the row that already exists, so
       * every trace of the previous outcome is cleared: `respondedAt` and
       * `removedAt` described a decision that no longer stands, and leaving
       * them would make the row read as both newly invited and already
       * declined. `invitedAt` moves to now for the same reason — the tester's
       * "invited" date is the one they are being asked about.
       */
      ...toRevive.map((row) =>
        prisma.projectAssignment.update({
          where: { id: row.id },
          data: {
            status: AssignmentStatus.INVITED,
            invitedAt: new Date(),
            respondedAt: null,
            removedAt: null,
            completedAt: null,
            ...(notes ? { notes } : {}),
            assignedDeviceId: configured.get(row.testerId)?.deviceId ?? null,
            assignedBrowserId: configured.get(row.testerId)?.browserId ?? null,
          },
        }),
      ),
    ])

    await createNotifications(invitedTesterIds, {
      type: 'PROJECT_ASSIGNED',
      title: `You have been invited to test "${project.title}"`,
      body: notes,
      // Carries the build so a tester invited onto two builds of the same
      // project gets two notifications that actually land on the right one,
      // rather than both pointing at whichever build the project defaults
      // to.
      link: `/app/tester/projects/${projectId}?buildId=${buildId}`,
    })
  }

  return {
    invited: toCreate.length,
    /**
     * Reported separately from `invited` because the two read differently to
     * whoever pressed the button: "3 invited" and "3 invited, 1 brought back"
     * are different facts, and a revived tester is one the reader had
     * previously taken off or been turned down by.
     */
    reinvited: toRevive.length,
    /** Only genuinely untouched rows — someone already live on this build. */
    skipped: blocked.size,
    assignments: await prisma.projectAssignment.findMany({
      where: { projectId, buildId },
      select: {
        buildId: true,
        status: true,
        invitedAt: true,
        respondedAt: true,
        tester: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    }),
  }
}

/**
 * §2.3 — a tester accepts or declines their invitation to a specific build.
 *
 * `buildId` is required now that a tester can hold more than one row on the
 * same project: `(projectId, testerId)` alone no longer names a single
 * invitation to answer.
 */
export async function respondToAssignment(
  testerId: string,
  projectId: string,
  buildId: string,
  response: 'ACCEPTED' | 'DECLINED',
  notes?: string,
) {
  const assignment = await prisma.projectAssignment.findFirst({
    where: { projectId, buildId, testerId },
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

/**
 * Admin-side change to an assignment: activate, complete or remove a tester
 * FROM ONE BUILD. `buildId` is required for the same reason it is on
 * `respondToAssignment` — the tester may hold several rows on this project.
 */
export async function updateAssignment(
  projectId: string,
  buildId: string,
  testerId: string,
  status: AssignmentStatus,
  notes?: string,
) {
  const assignment = await prisma.projectAssignment.findFirst({
    where: { projectId, buildId, testerId },
    select: { id: true },
  })
  if (!assignment) throw new NotFoundError('Assignment')

  /**
   * The two stamps track the status, in BOTH directions.
   *
   * They used to be set on the way in and never cleared, so a tester taken
   * off a build and then put back kept a `removedAt` while reading as
   * ACCEPTED — a row that says it was removed at a timestamp and is currently
   * active. Anything reporting on either field had to know to ignore it,
   * which is the kind of thing nothing ever remembers to do.
   */
  const now = new Date()
  return prisma.projectAssignment.update({
    where: { id: assignment.id },
    data: {
      status,
      ...(notes ? { notes } : {}),
      completedAt: status === AssignmentStatus.COMPLETED ? now : null,
      removedAt: status === AssignmentStatus.REMOVED ? now : null,
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
        build: { select: { id: true, name: true } },
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

  /**
   * What the tester actually did on each BUILD, for the work-history view.
   *
   * Grouped by (projectId, buildId) rather than projectId alone — a tester
   * can now hold two assignment rows on the same project, and without the
   * build in the key both rows would show the SAME project-wide total,
   * reading as double-counting rather than two builds' real, different
   * counts.
   *
   * Two grouped counts rather than a per-row subquery: one round trip each
   * regardless of how many assignments come back, instead of 2N. Both are
   * scoped to `reportedById: testerId`, so this can only ever count the
   * caller's own bugs — a tester never learns how many defects anyone else
   * filed.
   *
   * "Accepted" reuses `ACCEPTED_BUG_STATUSES` from the testers service, which
   * is what the profile header's own counter uses.
   */
  const projectIds = items.map((a) => a.project.id)
  const [reported, accepted] = projectIds.length
    ? await Promise.all([
        prisma.bug.groupBy({
          by: ['projectId', 'buildId'],
          where: { reportedById: testerId, deletedAt: null, projectId: { in: projectIds } },
          _count: { _all: true },
        }),
        prisma.bug.groupBy({
          by: ['projectId', 'buildId'],
          where: {
            reportedById: testerId,
            deletedAt: null,
            projectId: { in: projectIds },
            status: { in: ACCEPTED_BUG_STATUSES },
          },
          _count: { _all: true },
        }),
      ])
    : [[], []]

  const key = (projectId: string, buildId: string): string => `${projectId}:${buildId}`
  const reportedBy = new Map(reported.map((r) => [key(r.projectId, r.buildId), r._count._all]))
  const acceptedBy = new Map(accepted.map((r) => [key(r.projectId, r.buildId), r._count._all]))

  return {
    items: items.map((a) => ({
      ...a,
      bugsReported: reportedBy.get(key(a.project.id, a.build.id)) ?? 0,
      bugsAccepted: acceptedBy.get(key(a.project.id, a.build.id)) ?? 0,
    })),
    meta: buildMeta(query, total),
  }
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

export async function getBuild(
  user: Express.AuthenticatedUser,
  projectId: string,
  buildId: string,
) {
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

/**
 * Creates a build with whatever details the caller supplied.
 *
 * `input` carries the same fields as an edit, `name` included. Taking them
 * all here is what lets a create be one write: callers previously had to POST
 * a name and then PATCH the rest, and a failure between the two left a build
 * with no details behind a client that had already moved on.
 */
export async function createBuild(
  user: Express.AuthenticatedUser,
  projectId: string,
  input: Record<string, unknown> & { name: string },
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, 'project.update', resolved.relations)

  const existing = await prisma.build.findFirst({
    where: { projectId, name: input.name, deletedAt: null },
    select: { id: true },
  })
  if (existing) throw new ConflictError('A build with this name already exists on this project')

  return prisma.build.create({
    data: { ...input, projectId },
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
export async function copyBuild(
  user: Express.AuthenticatedUser,
  projectId: string,
  buildId: string,
) {
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

  const features = await prisma.feature.findMany({ where: { buildId }, select: { name: true } })

  /**
   * One transaction, because a copy is one thing to the user.
   *
   * The build and its features were previously written separately. A failure
   * between them left a build carrying the source's settings but none of its
   * features — a half-copy that looks complete, since nothing on screen says
   * how many features there should have been.
   */
  return prisma.$transaction(async (tx) => {
    const copy = await tx.build.create({
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

    if (features.length === 0) return copy

    await tx.feature.createMany({
      data: features.map((f) => ({ projectId, buildId: copy.id, name: f.name })),
    })
    // `copy`'s `_count.features` was snapshotted before the createMany above —
    // re-read so the response the caller sees matches what actually happened.
    return tx.build.findUniqueOrThrow({ where: { id: copy.id }, select: buildSelect })
  })
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

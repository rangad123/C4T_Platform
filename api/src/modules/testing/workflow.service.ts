import {
  type Prisma,
  AssignmentStatus,
  ExecutionReviewStatus,
  ProjectApplicationStatus,
  ProjectStatus,
  Role,
  TimesheetStatus,
} from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { buildMeta, toSkipTake } from '../../lib/pagination.js'
import { projectRelations } from '../../lib/access/relations.js'
import { authorize, can, type Action } from '../../lib/access/policy.js'
import { PERMISSIONS } from '../../config/permissions.js'
import { createNotification, createNotifications } from '../notifications/notifications.service.js'
import { assertAssignable } from '../testers/testers.service.js'
import { assignTesters, isProjectOpenForWork } from '../projects/projects.service.js'
import type {
  ListApplicationsQuery,
  ListExecutionsQuery,
  ListTimesheetsQuery,
} from './workflow.schema.js'

/**
 * The rest of the legacy testing workflow, on top of test cases:
 *
 *   tester applies to a build ──> admin/manager accepts ──> tester is on the roster
 *   tester runs a case ──> execution (TestReport) ──> reviewer approves / rejects
 *   tester logs time per build per day ──> reviewer approves (possibly fewer minutes)
 *
 * Who decides is the same relationship model as everywhere else: an admin, a
 * sub-admin with the permission, or the project's manager. A customer cannot
 * staff a project today (`project.assign_testers`), so they decide nothing
 * here; they read progress through the build summary. Approving time records
 * it only — no transaction is created, payouts stay a separate admin act.
 */

const person = { select: { id: true, firstName: true, lastName: true, email: true } } as const

/** Same list as `isProjectOpenForWork`, needed as a filter rather than a test. */
const OPEN_FOR_WORK: ProjectStatus[] = [ProjectStatus.APPROVED, ProjectStatus.IN_PROGRESS]

const LIVE_ASSIGNMENT: AssignmentStatus[] = [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE]

async function buildWithProject(buildId: string) {
  const build = await prisma.build.findFirst({
    where: { id: buildId, deletedAt: null, project: { deletedAt: null } },
    select: {
      id: true,
      name: true,
      projectId: true,
      acceptsApplications: true,
      project: { select: { title: true, status: true } },
    },
  })
  if (!build) throw new NotFoundError('Build')
  return build
}

/** Project-level gate for one decision: 404 when the project is not theirs to see. */
async function authorizeOnProject(
  user: Express.AuthenticatedUser,
  projectId: string,
  action: Action,
) {
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'project.read', resolved.relations)) {
    throw new NotFoundError('Project')
  }
  authorize(user, action, resolved.relations)
  return resolved
}

/**
 * Which projects a review queue covers for this user.
 *
 * With a project (or build) named: that one, if the user may decide there.
 * Without: every project for an admin or an unscoped sub-admin holding the
 * permission, only the managed ones for any other sub-admin. A customer or a
 * tester has no queue.
 */
async function queueScope(
  user: Express.AuthenticatedUser,
  action: 'testing.review' | 'project.assign_testers',
  query: { projectId?: string; buildId?: string },
): Promise<{ project: Prisma.ProjectWhereInput; buildId?: string }> {
  let projectId = query.projectId
  if (query.buildId) {
    const build = await buildWithProject(query.buildId)
    if (projectId && projectId !== build.projectId) throw new NotFoundError('Build')
    projectId = build.projectId
  }

  if (projectId) {
    const resolved = await projectRelations(user, projectId)
    if (!resolved || !can(user, action, resolved.relations)) throw new NotFoundError('Project')
    return { project: { id: projectId }, ...(query.buildId ? { buildId: query.buildId } : {}) }
  }

  if (user.role === Role.ADMIN) return { project: { deletedAt: null } }
  if (user.role === Role.SUB_ADMIN) {
    const permission =
      action === 'testing.review' ? PERMISSIONS.PROJECT_WRITE : PERMISSIONS.PROJECT_ASSIGN
    const broad =
      user.permissions.includes(permission) &&
      !user.permissions.includes(PERMISSIONS.PROJECT_SCOPE_TO_ASSIGNED)
    return {
      project: broad
        ? { deletedAt: null }
        : { deletedAt: null, managers: { some: { managerId: user.id } } },
    }
  }
  throw new ForbiddenError('You do not have a review queue')
}

async function notifyManagers(projectId: string, payload: { title: string; link: string }) {
  const managers = await prisma.managerAssignment.findMany({
    where: { projectId },
    select: { managerId: true },
  })
  await createNotifications(
    managers.map((m) => m.managerId),
    { type: 'PROJECT_ASSIGNED', ...payload },
  )
}

// ─── Applications ────────────────────────────────────────────────────────────

/** Admin/manager switch: may verified testers apply to this build themselves? */
export async function setApplicationsOpen(
  user: Express.AuthenticatedUser,
  buildId: string,
  open: boolean,
) {
  const build = await buildWithProject(buildId)
  await authorizeOnProject(user, build.projectId, 'project.assign_testers')
  return prisma.build.update({
    where: { id: buildId },
    data: { acceptsApplications: open },
    select: { id: true, acceptsApplications: true },
  })
}

/**
 * What a tester can apply to: builds switched open, on projects that can take
 * testers now. Only what a tester needs to decide — never the brief, the
 * customer's name or the roster.
 */
export async function listOpenBuilds(user: Express.AuthenticatedUser) {
  if (user.role !== Role.TESTER) throw new ForbiddenError('Only testers apply for work')
  const builds = await prisma.build.findMany({
    where: {
      acceptsApplications: true,
      deletedAt: null,
      project: { deletedAt: null, status: { in: OPEN_FOR_WORK } },
    },
    select: {
      id: true,
      name: true,
      testType: true,
      startDate: true,
      endDate: true,
      targetDevices: true,
      targetBrowsers: true,
      targetCountries: true,
      project: { select: { id: true, title: true, summary: true, platformTargets: true } },
      applications: {
        where: { testerId: user.id },
        select: { id: true, status: true, decisionNote: true, createdAt: true },
      },
      assignments: { where: { testerId: user.id }, select: { status: true } },
    },
    orderBy: { createdAt: 'desc' },
    // shortcut: no paging; upgrade when more than 100 builds are open at once.
    take: 100,
  })
  return builds.map(({ applications, assignments, ...build }) => ({
    ...build,
    myApplication: applications[0] ?? null,
    myAssignmentStatus: assignments[0]?.status ?? null,
  }))
}

export async function apply(
  user: Express.AuthenticatedUser,
  input: { buildId: string; message?: string },
) {
  if (user.role !== Role.TESTER) throw new ForbiddenError('Only testers apply for work')
  const build = await buildWithProject(input.buildId)
  // A build that is not open looks the same as one that does not exist.
  if (!build.acceptsApplications || !isProjectOpenForWork(build.project.status)) {
    throw new NotFoundError('Build')
  }
  await assertAssignable(user.id)

  const onRoster = await prisma.projectAssignment.findFirst({
    where: {
      buildId: build.id,
      testerId: user.id,
      status: { notIn: [AssignmentStatus.DECLINED, AssignmentStatus.REMOVED] },
    },
    select: { id: true },
  })
  if (onRoster) throw new ConflictError('You are already on this build')

  const existing = await prisma.projectApplication.findUnique({
    where: { buildId_testerId: { buildId: build.id, testerId: user.id } },
    select: { status: true },
  })
  if (existing?.status === ProjectApplicationStatus.PENDING) {
    throw new ConflictError('You have already applied to this build')
  }

  // A declined, withdrawn or spent application is reopened rather than duplicated.
  const application = await prisma.projectApplication.upsert({
    where: { buildId_testerId: { buildId: build.id, testerId: user.id } },
    create: {
      projectId: build.projectId,
      buildId: build.id,
      testerId: user.id,
      message: input.message ?? null,
    },
    update: {
      status: ProjectApplicationStatus.PENDING,
      message: input.message ?? null,
      decisionNote: null,
      decidedById: null,
      decidedAt: null,
    },
    select: { id: true, status: true, buildId: true, projectId: true, createdAt: true },
  })

  await notifyManagers(build.projectId, {
    title: `A tester applied to "${build.project.title}" (${build.name})`,
    link: '/app/admin/testing?section=applications',
  })
  return application
}

export async function listApplications(
  user: Express.AuthenticatedUser,
  query: ListApplicationsQuery,
) {
  const where: Prisma.ProjectApplicationWhereInput =
    user.role === Role.TESTER
      ? { testerId: user.id }
      : await queueScope(user, 'project.assign_testers', query)
  if (query.status) where.status = query.status

  const [items, total] = await Promise.all([
    prisma.projectApplication.findMany({
      where,
      select: {
        id: true,
        status: true,
        message: true,
        decisionNote: true,
        decidedAt: true,
        createdAt: true,
        tester: person,
        decidedBy: { select: { id: true, firstName: true, lastName: true } },
        build: { select: { id: true, name: true } },
        project: { select: { id: true, reference: true, title: true } },
      },
      orderBy: { createdAt: query.order },
      ...toSkipTake(query),
    }),
    prisma.projectApplication.count({ where }),
  ])
  return { items, meta: buildMeta(query, total) }
}

export async function decideApplication(
  user: Express.AuthenticatedUser,
  id: string,
  input: { decision: 'ACCEPTED' | 'DECLINED'; note?: string },
) {
  const application = await prisma.projectApplication.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      projectId: true,
      buildId: true,
      testerId: true,
      project: { select: { title: true } },
    },
  })
  if (!application) throw new NotFoundError('Application')
  await authorizeOnProject(user, application.projectId, 'project.assign_testers')
  if (application.status !== ProjectApplicationStatus.PENDING) {
    throw new ConflictError(`This application was already answered (${application.status})`)
  }

  // Staffing goes through the one roster path, so the tester checks and the
  // project's tester cap apply exactly as they do to an invitation.
  if (input.decision === 'ACCEPTED') {
    await assignTesters(
      application.projectId,
      [application.testerId],
      input.note,
      application.buildId,
      undefined,
      true,
    )
  }

  const { count } = await prisma.projectApplication.updateMany({
    where: { id, status: ProjectApplicationStatus.PENDING },
    data: {
      status: input.decision,
      decisionNote: input.note ?? null,
      decidedById: user.id,
      decidedAt: new Date(),
    },
  })
  if (count === 0) throw new ConflictError('This application was already answered')

  if (input.decision === 'DECLINED') {
    await createNotification({
      userId: application.testerId,
      type: 'PROJECT_ASSIGNED',
      title: `Your application to test "${application.project.title}" was declined`,
      body: input.note,
      link: '/app/tester/apply',
    })
  }
  return { id, status: input.decision }
}

export async function withdrawApplication(user: Express.AuthenticatedUser, id: string) {
  const { count } = await prisma.projectApplication.updateMany({
    where: { id, testerId: user.id, status: ProjectApplicationStatus.PENDING },
    data: { status: ProjectApplicationStatus.WITHDRAWN },
  })
  if (count === 0) throw new NotFoundError('Application')
}

// ─── Execution reviews ───────────────────────────────────────────────────────

export async function listExecutions(user: Express.AuthenticatedUser, query: ListExecutionsQuery) {
  let where: Prisma.TestReportWhereInput
  if (user.role === Role.TESTER) {
    where = { testerId: user.id }
  } else {
    const scope = await queueScope(user, 'testing.review', query)
    where = {
      build: { project: scope.project },
      ...(scope.buildId ? { buildId: scope.buildId } : {}),
    }
  }
  where.testCase = { deletedAt: null }
  if (query.reviewStatus) where.reviewStatus = query.reviewStatus

  const [items, total] = await Promise.all([
    prisma.testReport.findMany({
      where,
      select: {
        id: true,
        result: true,
        notes: true,
        devices: true,
        browsers: true,
        createdAt: true,
        reviewStatus: true,
        reviewNote: true,
        reviewedAt: true,
        tester: person,
        testCase: { select: { id: true, title: true } },
        build: {
          select: {
            id: true,
            name: true,
            project: { select: { id: true, reference: true, title: true } },
          },
        },
        linkedBug: { select: { id: true, reference: true, title: true } },
      },
      orderBy: { createdAt: query.order },
      ...toSkipTake(query),
    }),
    prisma.testReport.count({ where }),
  ])
  return { items, meta: buildMeta(query, total) }
}

export async function reviewExecution(
  user: Express.AuthenticatedUser,
  id: string,
  input: { decision: 'APPROVED' | 'REJECTED'; note?: string },
) {
  const report = await prisma.testReport.findUnique({
    where: { id },
    select: {
      id: true,
      testerId: true,
      buildId: true,
      reviewStatus: true,
      testCase: { select: { title: true } },
      build: { select: { projectId: true } },
    },
  })
  if (!report) throw new NotFoundError('Execution')
  await authorizeOnProject(user, report.build.projectId, 'testing.review')

  const { count } = await prisma.testReport.updateMany({
    where: { id, reviewStatus: ExecutionReviewStatus.PENDING },
    data: {
      reviewStatus: input.decision,
      reviewNote: input.note ?? null,
      reviewedById: user.id,
      reviewedAt: new Date(),
    },
  })
  if (count === 0) throw new ConflictError('This execution was already reviewed')

  await createNotification({
    userId: report.testerId,
    type: 'PROJECT_ASSIGNED',
    title: `Your result for "${report.testCase.title}" was ${input.decision === 'APPROVED' ? 'approved' : 'rejected'}`,
    body: input.note,
    link: `/app/tester/projects/${report.build.projectId}?buildId=${report.buildId}&section=testing`,
  })
  return { id, reviewStatus: input.decision }
}

// ─── Timesheets ──────────────────────────────────────────────────────────────

const timesheetSelect = {
  id: true,
  workDate: true,
  minutes: true,
  description: true,
  status: true,
  approvedMinutes: true,
  reviewNote: true,
  reviewedAt: true,
  createdAt: true,
  tester: person,
  build: { select: { id: true, name: true } },
  project: { select: { id: true, reference: true, title: true } },
} satisfies Prisma.TimesheetEntrySelect

/** Log (or correct) a day's time on one build. An approved day is final. */
export async function logTime(
  user: Express.AuthenticatedUser,
  input: { buildId: string; workDate: string; minutes: number; description?: string },
) {
  if (user.role !== Role.TESTER) throw new ForbiddenError('Only testers log time')
  const build = await buildWithProject(input.buildId)
  const onBuild = await prisma.projectAssignment.findFirst({
    where: { buildId: build.id, testerId: user.id, status: { in: LIVE_ASSIGNMENT } },
    select: { id: true },
  })
  if (!onBuild) throw new NotFoundError('Build')

  const workDate = new Date(`${input.workDate}T00:00:00.000Z`)
  if (Number.isNaN(workDate.getTime()) || workDate.toISOString().slice(0, 10) !== input.workDate) {
    throw new BadRequestError('That is not a real date')
  }
  // One day of slack: a tester ahead of UTC can be on "tomorrow" already.
  if (workDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw new BadRequestError('Time cannot be logged for a day that has not happened yet')
  }

  const key = { buildId_testerId_workDate: { buildId: build.id, testerId: user.id, workDate } }
  const existing = await prisma.timesheetEntry.findUnique({ where: key, select: { status: true } })
  if (existing?.status === TimesheetStatus.APPROVED) {
    throw new ConflictError('That day is already approved and cannot be changed')
  }

  const entry = await prisma.timesheetEntry.upsert({
    where: key,
    create: {
      projectId: build.projectId,
      buildId: build.id,
      testerId: user.id,
      workDate,
      minutes: input.minutes,
      description: input.description ?? null,
    },
    update: {
      minutes: input.minutes,
      description: input.description ?? null,
      status: TimesheetStatus.PENDING,
      approvedMinutes: null,
      reviewNote: null,
      reviewedById: null,
      reviewedAt: null,
    },
    select: timesheetSelect,
  })
  return entry
}

export async function listTimesheets(user: Express.AuthenticatedUser, query: ListTimesheetsQuery) {
  const where: Prisma.TimesheetEntryWhereInput =
    user.role === Role.TESTER
      ? { testerId: user.id }
      : await queueScope(user, 'testing.review', query)
  if (user.role === Role.TESTER && query.buildId) where.buildId = query.buildId
  if (query.status) where.status = query.status

  const [items, total] = await Promise.all([
    prisma.timesheetEntry.findMany({
      where,
      select: timesheetSelect,
      orderBy: [{ workDate: query.order }, { createdAt: query.order }],
      ...toSkipTake(query),
    }),
    prisma.timesheetEntry.count({ where }),
  ])
  return { items, meta: buildMeta(query, total) }
}

export async function reviewTimesheet(
  user: Express.AuthenticatedUser,
  id: string,
  input: { decision: 'APPROVED' | 'REJECTED'; approvedMinutes?: number; note?: string },
) {
  const entry = await prisma.timesheetEntry.findUnique({
    where: { id },
    select: { id: true, projectId: true, testerId: true, minutes: true, workDate: true },
  })
  if (!entry) throw new NotFoundError('Timesheet entry')
  await authorizeOnProject(user, entry.projectId, 'testing.review')

  const approvedMinutes =
    input.decision === 'APPROVED' ? (input.approvedMinutes ?? entry.minutes) : null
  if (approvedMinutes !== null && approvedMinutes > entry.minutes) {
    throw new BadRequestError('Approved time cannot be more than the time logged')
  }

  const { count } = await prisma.timesheetEntry.updateMany({
    where: { id, status: TimesheetStatus.PENDING },
    data: {
      status: input.decision,
      approvedMinutes,
      reviewNote: input.note ?? null,
      reviewedById: user.id,
      reviewedAt: new Date(),
    },
  })
  if (count === 0) throw new ConflictError('This entry was already reviewed')

  await createNotification({
    userId: entry.testerId,
    type: 'PROJECT_ASSIGNED',
    title: `Your time for ${entry.workDate.toISOString().slice(0, 10)} was ${input.decision === 'APPROVED' ? 'approved' : 'rejected'}`,
    body: input.note,
    link: '/app/tester/timesheets',
  })
  return prisma.timesheetEntry.findUniqueOrThrow({ where: { id }, select: timesheetSelect })
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

export async function listScenarios(user: Express.AuthenticatedUser, buildId: string) {
  const build = await buildWithProject(buildId)
  const resolved = await projectRelations(user, build.projectId)
  if (!resolved || !can(user, 'testcase.read', resolved.relations)) throw new NotFoundError('Build')
  return prisma.testScenario.findMany({
    where: { buildId },
    select: {
      id: true,
      title: true,
      description: true,
      createdAt: true,
      _count: { select: { testCases: { where: { deletedAt: null } } } },
    },
    orderBy: { createdAt: 'asc' },
  })
}

export async function createScenario(
  user: Express.AuthenticatedUser,
  buildId: string,
  input: { title: string; description?: string },
) {
  const build = await buildWithProject(buildId)
  await authorizeOnProject(user, build.projectId, 'testcase.manage')
  return prisma.testScenario.create({
    data: {
      buildId,
      title: input.title,
      description: input.description ?? null,
      createdById: user.id,
    },
    select: { id: true, title: true, description: true, createdAt: true },
  })
}

/** Removing a scenario keeps its test cases; they just stop being grouped. */
export async function deleteScenario(user: Express.AuthenticatedUser, id: string) {
  const scenario = await prisma.testScenario.findUnique({
    where: { id },
    select: { build: { select: { projectId: true } } },
  })
  if (!scenario) throw new NotFoundError('Scenario')
  await authorizeOnProject(user, scenario.build.projectId, 'testcase.manage')
  await prisma.testScenario.delete({ where: { id } })
}

import { type Prisma, AssignmentStatus, type TestCaseResult } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, BadRequestError, ConflictError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { projectRelations } from '../../lib/access/relations.js'
import { authorize, can } from '../../lib/access/policy.js'
import { createNotifications } from '../notifications/notifications.service.js'
import { TEST_CASE_SORT_FIELDS, type ListTestCasesQuery } from './testing.schema.js'

/**
 * Structured testing workflow — legacy `test_case` / `assign_testCase` /
 * `test_report` / `test_review`. See the schema comment on `TestCase` in
 * schema.prisma for what this deliberately does and doesn't model.
 *
 * Every function resolves the owning project from the build first, because
 * access is decided by the caller's relationship to the PROJECT (same
 * pattern as bugs.service.ts) — a test case has no visibility rule of its
 * own beyond that.
 */

async function projectIdForBuild(buildId: string): Promise<{ projectId: string }> {
  const build = await prisma.build.findFirst({
    where: { id: buildId, deletedAt: null },
    select: { projectId: true },
  })
  if (!build) throw new NotFoundError('Build')
  return build
}

const testCaseSelect = {
  id: true,
  buildId: true,
  feature: true,
  title: true,
  description: true,
  steps: true,
  expectedResult: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
  build: {
    select: {
      id: true,
      name: true,
      project: { select: { id: true, reference: true, title: true } },
    },
  },
  assignments: {
    select: {
      id: true,
      assignedAt: true,
      tester: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
  reports: {
    select: {
      id: true,
      result: true,
      notes: true,
      devices: true,
      browsers: true,
      linkedBugId: true,
      createdAt: true,
      tester: { select: { id: true, firstName: true, lastName: true, email: true } },
      linkedBug: { select: { id: true, reference: true, title: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
  _count: { select: { reports: true } },
} satisfies Prisma.TestCaseSelect

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listTestCases(user: Express.AuthenticatedUser, query: ListTestCasesQuery) {
  let where: Prisma.TestCaseWhereInput

  if (query.buildId) {
    const { projectId } = await projectIdForBuild(query.buildId)
    const resolved = await projectRelations(user, projectId)
    if (!resolved || !can(user, 'testcase.read', resolved.relations)) {
      throw new NotFoundError('Build')
    }

    // A tester sees only the cases assigned to them — mirrors bugScope's
    // reporter-only default for a plain tester.
    const isPlainTester =
      !resolved.relations.has('platform:admin') &&
      !resolved.relations.has('platform:subadmin') &&
      !resolved.relations.has('project:manager') &&
      !resolved.relations.has('project:customer')

    where = {
      buildId: query.buildId,
      deletedAt: null,
      ...(isPlainTester ? { assignments: { some: { testerId: user.id } } } : {}),
    }
  } else {
    // No build named — only a tester may ask this ("every case assigned to
    // me", the tester portal's own view). Everyone else needs a build to
    // scope to, the same way `bugs` needs a `projectId`.
    if (user.role !== 'TESTER') {
      throw new BadRequestError('buildId is required')
    }
    where = { deletedAt: null, assignments: { some: { testerId: user.id } } }
  }

  where = {
    ...where,
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { feature: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.testCase.findMany({
      where,
      select: testCaseSelect,
      orderBy: buildOrderBy(query.sort, query.order, TEST_CASE_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.testCase.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

export async function getTestCase(user: Express.AuthenticatedUser, id: string) {
  const testCase = await prisma.testCase.findFirst({
    where: { id, deletedAt: null },
    select: testCaseSelect,
  })
  if (!testCase) throw new NotFoundError('Test case')

  const { projectId } = await projectIdForBuild(testCase.buildId)
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'testcase.read', resolved.relations)) {
    throw new NotFoundError('Test case')
  }

  const isAssignee = testCase.assignments.some((a) => a.tester.id === user.id)
  const isPlainTester =
    !resolved.relations.has('platform:admin') &&
    !resolved.relations.has('platform:subadmin') &&
    !resolved.relations.has('project:manager') &&
    !resolved.relations.has('project:customer')
  if (isPlainTester && !isAssignee) throw new NotFoundError('Test case')

  return {
    ...testCase,
    capabilities: {
      canManage: can(user, 'testcase.manage', resolved.relations),
      canReport: can(user, 'testreport.create', resolved.relations) && isAssignee,
    },
  }
}

// ─── Write ───────────────────────────────────────────────────────────────────

export async function createTestCase(
  user: Express.AuthenticatedUser,
  input: { buildId: string; feature?: string; title: string; description: string; steps: string; expectedResult: string },
) {
  const { projectId } = await projectIdForBuild(input.buildId)
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'testcase.read', resolved.relations)) {
    throw new NotFoundError('Build')
  }
  authorize(user, 'testcase.manage', resolved.relations)

  return prisma.testCase.create({
    data: {
      buildId: input.buildId,
      feature: input.feature ?? null,
      title: input.title,
      description: input.description,
      steps: input.steps,
      expectedResult: input.expectedResult,
      createdById: user.id,
    },
    select: testCaseSelect,
  })
}

async function loadForWrite(user: Express.AuthenticatedUser, id: string) {
  const testCase = await prisma.testCase.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, buildId: true },
  })
  if (!testCase) throw new NotFoundError('Test case')
  const { projectId } = await projectIdForBuild(testCase.buildId)
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'testcase.read', resolved.relations)) {
    throw new NotFoundError('Test case')
  }
  authorize(user, 'testcase.manage', resolved.relations)
  return testCase
}

export async function updateTestCase(
  user: Express.AuthenticatedUser,
  id: string,
  input: Record<string, unknown>,
) {
  await loadForWrite(user, id)
  return prisma.testCase.update({
    where: { id },
    data: input,
    select: testCaseSelect,
  })
}

export async function deleteTestCase(user: Express.AuthenticatedUser, id: string): Promise<void> {
  await loadForWrite(user, id)
  await prisma.testCase.update({ where: { id }, data: { deletedAt: new Date() } })
}

export async function assignTesters(
  user: Express.AuthenticatedUser,
  testCaseId: string,
  testerIds: string[],
) {
  const testCase = await loadForWrite(user, testCaseId)

  // Only testers with a live assignment on this build's project may be
  // handed a test case — same eligibility bar as inviting them onto the
  // roster in the first place.
  const { projectId } = await projectIdForBuild(testCase.buildId)
  const eligible = await prisma.projectAssignment.findMany({
    where: {
      projectId,
      testerId: { in: testerIds },
      status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE] },
    },
    select: { testerId: true },
  })
  const eligibleIds = new Set(eligible.map((e) => e.testerId))
  const ineligible = testerIds.filter((id) => !eligibleIds.has(id))
  if (ineligible.length > 0) {
    throw new BadRequestError('Every tester must have an accepted or active assignment on this project')
  }

  await prisma.testCaseAssignment.createMany({
    data: testerIds.map((testerId) => ({ testCaseId, testerId })),
    skipDuplicates: true,
  })

  await createNotifications(testerIds, {
    type: 'PROJECT_ASSIGNED',
    title: 'A test case has been assigned to you',
    link: `/app/tester/test-cases/${testCaseId}`,
  })

  return prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId }, select: testCaseSelect })
}

export async function unassignTester(
  user: Express.AuthenticatedUser,
  testCaseId: string,
  testerId: string,
): Promise<void> {
  await loadForWrite(user, testCaseId)
  await prisma.testCaseAssignment.deleteMany({ where: { testCaseId, testerId } })
}

// ─── Test reports ────────────────────────────────────────────────────────────

export async function createTestReport(
  user: Express.AuthenticatedUser,
  testCaseId: string,
  input: {
    result: TestCaseResult
    notes?: string
    devices?: string
    browsers?: string
    linkedBugId?: string
  },
) {
  const testCase = await prisma.testCase.findFirst({
    where: { id: testCaseId, deletedAt: null },
    select: { id: true, buildId: true },
  })
  if (!testCase) throw new NotFoundError('Test case')

  const { projectId } = await projectIdForBuild(testCase.buildId)
  const resolved = await projectRelations(user, projectId)
  if (!resolved) throw new NotFoundError('Test case')
  authorize(user, 'testreport.create', resolved.relations)

  const assignment = await prisma.testCaseAssignment.findUnique({
    where: { testCaseId_testerId: { testCaseId, testerId: user.id } },
    select: { id: true },
  })
  if (!assignment) throw new ConflictError('This test case is not assigned to you')

  if (input.linkedBugId) {
    const bug = await prisma.bug.findFirst({
      where: { id: input.linkedBugId, projectId },
      select: { id: true },
    })
    if (!bug) throw new BadRequestError('That bug does not belong to this project')
  }

  const report = await prisma.testReport.create({
    data: {
      testCaseId,
      buildId: testCase.buildId,
      testerId: user.id,
      result: input.result,
      notes: input.notes ?? null,
      devices: input.devices ?? null,
      browsers: input.browsers ?? null,
      linkedBugId: input.linkedBugId ?? null,
    },
  })

  const [owners, managers] = await Promise.all([
    prisma.organisationMember.findMany({
      where: { organisationId: resolved.project.organisationId, orgRole: 'OWNER' },
      select: { userId: true },
    }),
    prisma.managerAssignment.findMany({ where: { projectId }, select: { managerId: true } }),
  ])
  await createNotifications(
    [...owners.map((o) => o.userId), ...managers.map((m) => m.managerId)],
    {
      type: 'BUG_REPORTED',
      title: `A test report (${input.result.toLowerCase()}) was filed`,
      link: `/app/admin/projects/${projectId}?section=testing`,
    },
  )

  return report
}

// ─── Test reviews ────────────────────────────────────────────────────────────

export async function listTestReviews(user: Express.AuthenticatedUser, buildId: string) {
  const { projectId } = await projectIdForBuild(buildId)
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'testcase.read', resolved.relations)) {
    throw new NotFoundError('Build')
  }
  return prisma.testReview.findMany({
    where: { buildId },
    select: {
      id: true,
      summary: true,
      rating: true,
      createdAt: true,
      createdBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createTestReview(
  user: Express.AuthenticatedUser,
  buildId: string,
  input: { summary: string; rating?: number },
) {
  const { projectId } = await projectIdForBuild(buildId)
  const resolved = await projectRelations(user, projectId)
  if (!resolved) throw new NotFoundError('Build')
  authorize(user, 'testreview.create', resolved.relations)

  return prisma.testReview.create({
    data: {
      buildId,
      summary: input.summary,
      rating: input.rating ?? null,
      createdById: user.id,
    },
    select: {
      id: true,
      summary: true,
      rating: true,
      createdAt: true,
      createdBy: { select: { id: true, firstName: true, lastName: true } },
    },
  })
}

// ─── Summary ─────────────────────────────────────────────────────────────────

/**
 * Build-level analytics — real aggregates only, no placeholders. Every count
 * here is a `groupBy`/`count` against rows that already exist for the build,
 * so an empty build renders honest zeros rather than a fabricated chart.
 */
export async function buildSummary(user: Express.AuthenticatedUser, buildId: string) {
  const { projectId } = await projectIdForBuild(buildId)
  const resolved = await projectRelations(user, projectId)
  if (!resolved || !can(user, 'testcase.read', resolved.relations)) {
    throw new NotFoundError('Build')
  }

  const [
    testerCount,
    bugsBySeverity,
    bugsByStatus,
    bugsByType,
    bugsByReproducibility,
    testCaseCount,
    reportsByResult,
    reviews,
  ] = await Promise.all([
    prisma.projectAssignment.count({
      where: { buildId, status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED] } },
    }),
    prisma.bug.groupBy({ by: ['severity'], where: { buildId, deletedAt: null }, _count: true }),
    prisma.bug.groupBy({ by: ['status'], where: { buildId, deletedAt: null }, _count: true }),
    prisma.bug.groupBy({ by: ['type'], where: { buildId, deletedAt: null, type: { not: null } }, _count: true }),
    prisma.bug.groupBy({ by: ['reproducibility'], where: { buildId, deletedAt: null }, _count: true }),
    prisma.testCase.count({ where: { buildId, deletedAt: null } }),
    prisma.testReport.groupBy({ by: ['result'], where: { buildId }, _count: true }),
    prisma.testReview.findMany({
      where: { buildId },
      select: { rating: true },
    }),
  ])

  const tally = <Row extends { _count: number }, T extends string>(
    rows: readonly Row[],
    keys: readonly T[],
    pick: (row: Row) => T,
  ) => {
    const out = {} as Record<T, number>
    for (const k of keys) out[k] = 0
    for (const row of rows) out[pick(row)] = row._count
    return out
  }

  const ratings = reviews.map((r) => r.rating).filter((r): r is number => r !== null)
  const averageRating = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null

  const testedCaseCount = reportsByResult.reduce((sum, r) => sum + r._count, 0)

  return {
    testerCount,
    bugCount: bugsByStatus.reduce((sum, r) => sum + r._count, 0),
    bugsBySeverity: tally(bugsBySeverity, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const, (r) => r.severity),
    bugsByStatus: tally(
      bugsByStatus,
      ['NEW', 'TRIAGED', 'CONFIRMED', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'REOPENED', 'REJECTED', 'WONT_FIX', 'DUPLICATE'] as const,
      (r) => r.status,
    ),
    bugsByType: Object.fromEntries(bugsByType.map((r) => [r.type as string, r._count])),
    bugsByReproducibility: tally(
      bugsByReproducibility,
      ['ALWAYS', 'SOMETIMES', 'RARELY', 'ONCE'] as const,
      (r) => r.reproducibility,
    ),
    testCaseCount,
    testCaseCompletion: testCaseCount > 0 ? Math.round((testedCaseCount / testCaseCount) * 100) : null,
    testReportsByResult: tally(reportsByResult, ['NOT_TESTED', 'PASS', 'FAIL', 'BLOCKED'] as const, (r) => r.result),
    reviewCount: reviews.length,
    averageRating,
  }
}

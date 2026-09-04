import { Router } from 'express'
import { z } from 'zod'
import { AssignmentStatus, type Prisma } from '@prisma/client'
import { authenticate } from '../../middleware/authenticate.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { NotFoundError, BadRequestError, ForbiddenError } from '../../lib/errors.js'
import { projectRelations } from '../../lib/access/relations.js'
import { bugScope } from '../../lib/access/scopes.js'
import { authorize } from '../../lib/access/policy.js'
import * as testingService from '../testing/testing.service.js'

/**
 * The Reports module — §15-21 of the platform UX brief.
 *
 * Deliberately NOT a second report engine: every JSON "view" is either
 * `testingService.buildSummary` (by build) or the same shape computed
 * across a wider scope (by project / date / build range).
 * The brief is explicit about this — "if the application already has
 * report-generation infrastructure, reuse it."
 */
export const reportsRouter = Router()

reportsRouter.use(authenticate)

async function assertProjectReportAccess(
  user: Express.AuthenticatedUser,
  projectId: string,
): Promise<{ organisationId: string }> {
  const resolved = await projectRelations(user, projectId)
  if (!resolved) throw new NotFoundError('Project')
  authorize(user, 'report.generate', resolved.relations)
  return { organisationId: resolved.project.organisationId }
}

/**
 * Tester counts by country for a project, across every build — the same
 * roster `testerCount` already counts, just broken down by
 * `TesterProfile.countryCode`. `countryCode` lives on the profile, one hop
 * past `ProjectAssignment.tester`, so this is grouped in JS rather than a
 * Prisma `groupBy` (which cannot group across a relation) — the roster on
 * one project is never large enough for that to matter.
 */
async function testersByCountry(projectId: string): Promise<Record<string, number>> {
  const rows = await prisma.projectAssignment.findMany({
    where: {
      projectId,
      status: {
        in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED],
      },
    },
    select: { tester: { select: { testerProfile: { select: { countryCode: true } } } } },
    // One tester on two builds of this project must count once, not twice.
    distinct: ['testerId'],
  })
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const code = row.tester.testerProfile?.countryCode ?? 'Unknown'
    counts[code] = (counts[code] ?? 0) + 1
  }
  return counts
}

/** Bug counts by severity/status/type/reproducibility for an arbitrary `where`. */
async function bugBreakdown(where: Prisma.BugWhereInput) {
  const [bySeverity, byStatus, byType, byReproducibility, total] = await Promise.all([
    prisma.bug.groupBy({ by: ['severity'], where, _count: true }),
    prisma.bug.groupBy({ by: ['status'], where, _count: true }),
    prisma.bug.groupBy({ by: ['type'], where: { ...where, type: { not: null } }, _count: true }),
    prisma.bug.groupBy({ by: ['reproducibility'], where, _count: true }),
    prisma.bug.count({ where }),
  ])
  return {
    total,
    bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r._count])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
    byType: Object.fromEntries(byType.map((r) => [r.type as string, r._count])),
    byReproducibility: Object.fromEntries(
      byReproducibility.map((r) => [r.reproducibility, r._count]),
    ),
  }
}

// ─── By project ──────────────────────────────────────────────────────────────

const projectIdParam = z.object({ projectId: z.string().cuid() })

reportsRouter.get(
  '/by-project/:projectId',
  validate({ params: projectIdParam }),
  async (req, res) => {
    const projectId = param(req, 'projectId')
    await assertProjectReportAccess(req.user!, projectId)

    const project = await prisma.project.findFirstOrThrow({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        reference: true,
        title: true,
        status: true,
        organisation: { select: { id: true, name: true } },
        builds: { where: { deletedAt: null }, select: { id: true, name: true, status: true } },
      },
    })

    const [testerCount, testCaseCount, bugs, byCountry] = await Promise.all([
      // Distinct testers, not roster rows — one person on two builds of this
      // project is still one tester.
      prisma.projectAssignment
        .findMany({
          where: {
            projectId,
            status: {
              in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED],
            },
          },
          select: { testerId: true },
          distinct: ['testerId'],
        })
        .then((rows) => rows.length),
      prisma.testCase.count({ where: { build: { projectId }, deletedAt: null } }),
      bugBreakdown({ projectId, deletedAt: null }),
      testersByCountry(projectId),
    ])

    res.json({
      data: {
        project: {
          id: project.id,
          reference: project.reference,
          title: project.title,
          status: project.status,
          organisation: project.organisation,
        },
        builds: project.builds,
        testerCount,
        testCaseCount,
        bugs,
        testersByCountry: byCountry,
      },
    })
  },
)

// ─── By build ────────────────────────────────────────────────────────────────

const buildIdParam = z.object({ buildId: z.string().cuid() })

async function loadBuildForReport(user: Express.AuthenticatedUser, buildId: string) {
  const build = await prisma.build.findFirst({
    where: { id: buildId, deletedAt: null },
    select: { id: true, projectId: true },
  })
  if (!build) throw new NotFoundError('Build')
  await assertProjectReportAccess(user, build.projectId)
  return build
}

reportsRouter.get('/by-build/:buildId', validate({ params: buildIdParam }), async (req, res) => {
  const buildId = param(req, 'buildId')
  await loadBuildForReport(req.user!, buildId)
  res.json({ data: await testingService.buildSummary(req.user!, buildId) })
})

// ─── By date ─────────────────────────────────────────────────────────────────
//
// Spans every project the caller can see rather than one.
//
// This used to be admin-side only, on the reasoning that reporting "across
// every project" is a platform privilege. That was right about the danger and
// wrong about the fix: it refused the caller instead of narrowing the query,
// so the customer portal's own "By date" tab — whose copy promises
// "everything reported across YOUR projects between two dates" — called this,
// got a 403 on every request, and rendered the swallowed failure as
// "That period could not be reported on. Refresh in a moment." It had never
// worked for a customer.
//
// `bugScope` is the module's existing answer to "which bugs may this user
// see", and it already agrees with `bugRelations`. It returns `{}` for
// platform users, so admin-side behaviour is unchanged; a customer gets their
// organisations' projects, and a tester their own reports. Composed under
// `AND` rather than spread, so it cannot collide with the keys set here.

const dateRangeQuery = z
  .object({ startDate: z.coerce.date(), endDate: z.coerce.date() })
  .refine((d) => d.endDate >= d.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  })

reportsRouter.get('/by-date', validate({ query: dateRangeQuery }), async (req, res) => {
  const { startDate, endDate } = validatedQuery<z.infer<typeof dateRangeQuery>>(res)

  const where: Prisma.BugWhereInput = {
    deletedAt: null,
    createdAt: { gte: startDate, lte: endDate },
    AND: [bugScope(req.user!)],
  }
  const [bugs, byProject] = await Promise.all([
    bugBreakdown(where),
    prisma.bug.groupBy({
      by: ['projectId'],
      where,
      _count: true,
      orderBy: { _count: { projectId: 'desc' } },
    }),
  ])

  const projects = await prisma.project.findMany({
    where: { id: { in: byProject.map((p) => p.projectId) } },
    select: { id: true, reference: true, title: true },
  })
  const projectById = new Map(projects.map((p) => [p.id, p]))

  res.json({
    data: {
      startDate,
      endDate,
      bugs,
      byProject: byProject.map((p) => ({
        project: projectById.get(p.projectId) ?? null,
        bugCount: p._count,
      })),
    },
  })
})

// ─── By build range ──────────────────────────────────────────────────────────

const buildRangeQuery = z.object({
  projectId: z.string().cuid(),
  startBuildId: z.string().cuid(),
  endBuildId: z.string().cuid(),
})

/**
 * Resolves an ordered, inclusive list of build ids between two builds of the
 * same project. Ordering is by `createdAt` — builds carry no numeric version
 * field, so creation order is the only reliable sequence.
 */
async function resolveBuildRange(
  user: Express.AuthenticatedUser,
  projectId: string,
  startBuildId: string,
  endBuildId: string,
): Promise<{ buildIds: string[]; builds: { id: string; name: string; createdAt: Date }[] }> {
  await assertProjectReportAccess(user, projectId)

  const builds = await prisma.build.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const start = builds.find((b) => b.id === startBuildId)
  const end = builds.find((b) => b.id === endBuildId)
  if (!start || !end) {
    throw new BadRequestError('Both builds must belong to the selected project')
  }

  const [lo, hi] = start.createdAt <= end.createdAt ? [start, end] : [end, start]
  const inRange = builds.filter((b) => b.createdAt >= lo.createdAt && b.createdAt <= hi.createdAt)
  return { buildIds: inRange.map((b) => b.id), builds: inRange }
}

reportsRouter.get('/by-build-range', validate({ query: buildRangeQuery }), async (req, res) => {
  const { projectId, startBuildId, endBuildId } =
    validatedQuery<z.infer<typeof buildRangeQuery>>(res)
  const { buildIds, builds } = await resolveBuildRange(
    req.user!,
    projectId,
    startBuildId,
    endBuildId,
  )

  const bugs = await bugBreakdown({ buildId: { in: buildIds }, deletedAt: null })
  res.json({ data: { projectId, builds, bugs } })
})

import { Router } from 'express'
import { z } from 'zod'
import { AssignmentStatus, type Prisma } from '@prisma/client'
import { authenticate } from '../../middleware/authenticate.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { isAdminSide } from '../../middleware/authorize.js'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { NotFoundError, BadRequestError, ForbiddenError } from '../../lib/errors.js'
import { projectRelations } from '../../lib/access/relations.js'
import { authorize } from '../../lib/access/policy.js'
import { timestampedFilename } from '../../lib/csv.js'
import * as bugsService from '../bugs/bugs.service.js'
import * as testingService from '../testing/testing.service.js'

/**
 * The Reports module — §15-21 of the platform UX brief.
 *
 * Deliberately NOT a second report engine: every CSV here is
 * `bugsService.exportBugsCSV` with a different `where`, and every JSON
 * "view" is either `testingService.buildSummary` (by build) or the same
 * shape computed across a wider scope (by project / date / build range).
 * The brief is explicit about this — "if the application already has
 * report-generation infrastructure, reuse it."
 */
export const reportsRouter = Router()

reportsRouter.use(authenticate)

const bugQueryDefaults = { page: 1, limit: 1, order: 'desc' as const }

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
    where: { projectId, status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED] } },
    select: { tester: { select: { testerProfile: { select: { countryCode: true } } } } },
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
    byReproducibility: Object.fromEntries(byReproducibility.map((r) => [r.reproducibility, r._count])),
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
      prisma.projectAssignment.count({
        where: { projectId, status: { in: [AssignmentStatus.ACCEPTED, AssignmentStatus.ACTIVE, AssignmentStatus.COMPLETED] } },
      }),
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

reportsRouter.get(
  '/by-project/:projectId/export.csv',
  validate({ params: projectIdParam }),
  async (req, res) => {
    const projectId = param(req, 'projectId')
    await assertProjectReportAccess(req.user!, projectId)
    const csv = await bugsService.exportBugsCSV(req.user!, {
      ...bugQueryDefaults,
      projectId,
    })
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader(
      'content-disposition',
      `attachment; filename="${timestampedFilename('report-by-project')}"`,
    )
    res.send(csv)
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

/** Also the Build page's "Download report" action — one endpoint, two entry points. */
reportsRouter.get(
  '/by-build/:buildId/export.csv',
  validate({ params: buildIdParam }),
  async (req, res) => {
    const buildId = param(req, 'buildId')
    await loadBuildForReport(req.user!, buildId)
    const csv = await bugsService.exportBugsCSV(req.user!, {
      ...bugQueryDefaults,
      buildId,
    })
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader(
      'content-disposition',
      `attachment; filename="${timestampedFilename('report-by-build')}"`,
    )
    res.send(csv)
  },
)

// ─── By date ─────────────────────────────────────────────────────────────────
//
// Spans every project the caller can see rather than one — admin-side only
// (a customer's or manager's `report.generate` grant is scoped to THEIR
// project, not the whole platform), matching how the dashboard's stats
// endpoint is gated.

const dateRangeQuery = z
  .object({ startDate: z.coerce.date(), endDate: z.coerce.date() })
  .refine((d) => d.endDate >= d.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  })

reportsRouter.get('/by-date', validate({ query: dateRangeQuery }), async (req, res) => {
  if (!isAdminSide(req.user!)) throw new ForbiddenError('Only the platform side can report across every project')
  const { startDate, endDate } = validatedQuery<z.infer<typeof dateRangeQuery>>(res)

  const where: Prisma.BugWhereInput = {
    deletedAt: null,
    createdAt: { gte: startDate, lte: endDate },
  }
  const [bugs, byProject] = await Promise.all([
    bugBreakdown(where),
    prisma.bug.groupBy({ by: ['projectId'], where, _count: true, orderBy: { _count: { projectId: 'desc' } } }),
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

reportsRouter.get(
  '/by-date/export.csv',
  validate({ query: dateRangeQuery }),
  async (req, res) => {
    if (!isAdminSide(req.user!)) throw new ForbiddenError('Only the platform side can report across every project')
    const { startDate, endDate } = validatedQuery<z.infer<typeof dateRangeQuery>>(res)
    const csv = await bugsService.exportBugsCSV(req.user!, {
      ...bugQueryDefaults,
      startDate,
      endDate,
    })
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader(
      'content-disposition',
      `attachment; filename="${timestampedFilename('report-by-date')}"`,
    )
    res.send(csv)
  },
)

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
  const { projectId, startBuildId, endBuildId } = validatedQuery<z.infer<typeof buildRangeQuery>>(res)
  const { buildIds, builds } = await resolveBuildRange(req.user!, projectId, startBuildId, endBuildId)

  const bugs = await bugBreakdown({ buildId: { in: buildIds }, deletedAt: null })
  res.json({ data: { projectId, builds, bugs } })
})

reportsRouter.get(
  '/by-build-range/export.csv',
  validate({ query: buildRangeQuery }),
  async (req, res) => {
    const { projectId, startBuildId, endBuildId } = validatedQuery<z.infer<typeof buildRangeQuery>>(res)
    const { buildIds } = await resolveBuildRange(req.user!, projectId, startBuildId, endBuildId)

    const csv = await bugsService.exportBugsCSV(req.user!, {
      ...bugQueryDefaults,
      projectId,
      buildIds,
    })
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader(
      'content-disposition',
      `attachment; filename="${timestampedFilename('report-by-build-range')}"`,
    )
    res.send(csv)
  },
)

import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getUser, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import {
  type BugBreakdown,
  breakdownBlocks,
  countBlock,
  csvResponse,
  row,
  slug,
} from '@/lib/reports/report-csv'

export const dynamic = 'force-dynamic'

/**
 * `/app/admin/reports/download` — the report on screen, as a CSV.
 *
 * The admin twin of the customer route next door. Four sections rather than
 * three: the admin page can report on a SINGLE build as well as a range, and
 * its by-date report is platform-wide rather than scoped to one organisation.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CONTAIN
 *
 * Aggregate counts only — no per-bug row, no name, no email, no tester
 * identity. `lib/reports/report-csv.ts` carries the full argument for why,
 * and it is worth reading before adding a column here.
 *
 * The by-date payload's `byProject` block IS written out, and that is a
 * deliberate distinction rather than an oversight: it is a bug count per
 * project, which is organisational rather than personal, it is already on the
 * page, and `stats.read` is a platform-side permission. A tester or a
 * customer cannot reach this route at all.
 *
 * ── AUTHORIZATION IS THE API'S
 *
 * Every branch calls the same `/v1/reports/*` endpoint the page itself calls,
 * through `serverFetch` so the session cookie travels with it. The permission
 * check below mirrors the page's own `requirePermission('stats.read')` so an
 * unentitled caller is refused here rather than one hop later; it is not what
 * protects the data.
 */

interface BuildOption {
  id: string
  name: string
}

interface ProjectRef {
  id: string
  reference: string
  title: string
}

interface ByProjectReport {
  project: ProjectRef & { status: string; organisation: { id: string; name: string } }
  builds: BuildOption[]
  testerCount: number
  testCaseCount: number
  bugs: BugBreakdown
}

/**
 * The by-build report IS the build summary — see `testingService.buildSummary`,
 * which `reports.routes.ts` reuses rather than running a second report engine.
 * Its distributions are named differently from every other report's, so they
 * are mapped onto `BugBreakdown` below rather than reshaped here.
 */
interface ByBuildReport {
  testerCount: number
  bugCount: number
  bugsBySeverity: Record<string, number>
  bugsByStatus: Record<string, number>
  bugsByType: Record<string, number>
  bugsByReproducibility: Record<string, number>
  testCaseCount: number
  testCaseCompletion: number | null
}

interface ByDateReport {
  bugs: BugBreakdown
  byProject: { project: ProjectRef | null; bugCount: number }[]
}

interface RangeReport {
  builds: BuildOption[]
  bugs: BugBreakdown
}

export async function GET(request: Request): Promise<Response> {
  const user = await getUser()
  if (!user || !hasPermission(user, 'stats.read')) {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const params = new URL(request.url).searchParams
  const section = params.get('section') ?? 'by-project'
  const projectId = params.get('projectId') ?? ''
  const buildId = params.get('buildId') ?? ''
  const startBuildId = params.get('startBuildId') ?? ''
  const endBuildId = params.get('endBuildId') ?? ''
  const startDate = params.get('startDate') ?? ''
  const endDate = params.get('endDate') ?? ''

  const generated = new Date().toISOString()

  try {
    if (section === 'by-project') {
      if (!projectId) return NextResponse.json({ error: 'Choose a project first' }, { status: 400 })

      const report = await serverFetch<ByProjectReport>(`reports/by-project/${projectId}`)
      const lines = [
        row('Crowd4Test report'),
        row('Report', 'By project'),
        row('Project', `${report.project.reference} · ${report.project.title}`),
        row('Organisation', report.project.organisation.name),
        row('Generated', generated),
        '',
        'Summary',
        row('Metric', 'Value'),
        row('Builds', report.builds.length),
        row('Testers', report.testerCount),
        row('Test cases', report.testCaseCount),
        row('Total bugs', report.bugs.total),
        '',
        ...countBlock('Bugs by severity', 'Severity', report.bugs.bySeverity),
        ...countBlock('Bugs by status', 'Status', report.bugs.byStatus),
        ...countBlock('Bugs by type', 'Type', report.bugs.byType),
        ...countBlock('Bugs by reproducibility', 'Reproducibility', report.bugs.byReproducibility),
      ]
      return csvResponse(lines, `report-by-project-${slug(report.project.reference)}.csv`)
    }

    if (section === 'by-build') {
      if (!buildId) return NextResponse.json({ error: 'Choose a build first' }, { status: 400 })

      const summary = await serverFetch<ByBuildReport>(`reports/by-build/${buildId}`)
      const lines = [
        row('Crowd4Test report'),
        row('Report', 'By build'),
        row('Generated', generated),
        '',
        'Summary',
        row('Metric', 'Value'),
        row('Testers', summary.testerCount),
        row('Test cases', summary.testCaseCount),
        row(
          'Test case completion',
          // Null is "no test cases to complete", which a bare 0% would
          // misreport as "none done".
          summary.testCaseCompletion === null ? 'Not applicable' : `${summary.testCaseCompletion}%`,
        ),
        row('Total bugs', summary.bugCount),
        '',
        ...countBlock('Bugs by severity', 'Severity', summary.bugsBySeverity),
        ...countBlock('Bugs by status', 'Status', summary.bugsByStatus),
        ...countBlock('Bugs by type', 'Type', summary.bugsByType),
        ...countBlock('Bugs by reproducibility', 'Reproducibility', summary.bugsByReproducibility),
      ]
      return csvResponse(lines, 'report-by-build.csv')
    }

    if (section === 'by-date') {
      if (!startDate || !endDate) {
        return NextResponse.json({ error: 'Choose both dates' }, { status: 400 })
      }

      const report = await serverFetch<ByDateReport>('reports/by-date', {
        query: { startDate, endDate },
      })
      const perProject = report.byProject ?? []
      const lines = [
        row('Crowd4Test report'),
        row('Report', 'By date'),
        row('From', startDate),
        row('To', endDate),
        row('Generated', generated),
        '',
        ...breakdownBlocks(report.bugs),
        ...(perProject.length > 0
          ? [
              'Bugs by project',
              row('Reference', 'Project', 'Bugs'),
              ...perProject.map((entry) =>
                row(
                  entry.project?.reference ?? '—',
                  entry.project?.title ?? 'Deleted project',
                  entry.bugCount,
                ),
              ),
              '',
            ]
          : []),
      ]
      return csvResponse(lines, `report-by-date-${slug(startDate)}-to-${slug(endDate)}.csv`)
    }

    if (section === 'by-build-range') {
      if (!projectId || !startBuildId || !endBuildId) {
        return NextResponse.json({ error: 'Choose a project and both builds' }, { status: 400 })
      }

      const report = await serverFetch<RangeReport>('reports/by-build-range', {
        query: { projectId, startBuildId, endBuildId },
      })
      const builds = report.builds ?? []
      const lines = [
        row('Crowd4Test report'),
        row('Report', 'By build range'),
        row('Generated', generated),
        '',
        ...(builds.length > 0
          ? ['Builds in range', row('Build'), ...builds.map((b) => row(b.name)), '']
          : []),
        ...breakdownBlocks(report.bugs),
      ]
      return csvResponse(lines, 'report-by-build-range.csv')
    }

    return NextResponse.json({ error: 'Unknown report' }, { status: 400 })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    if (status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

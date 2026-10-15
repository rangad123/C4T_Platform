import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getUser, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { buildSummaryWorkbook, type SummaryFigure } from '@/lib/reports/summary-report-xlsx'
import { fileSlug, xlsxResponse } from '@/lib/reports/xlsx-response'
import { FORMAT, titleCase } from '@/lib/reports/xlsx-kit'

export const dynamic = 'force-dynamic'

/**
 * `/app/admin/reports/download` — the report on screen, as an Excel workbook.
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

interface BugBreakdown {
  total: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  byType: Record<string, number>
  byReproducibility: Record<string, number>
}

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

  const generatedAt = new Date()

  try {
    if (section === 'by-project') {
      if (!projectId) return NextResponse.json({ error: 'Choose a project first' }, { status: 400 })

      const report = await serverFetch<ByProjectReport>(`reports/by-project/${projectId}`)
      const file = await buildSummaryWorkbook({
        kind: 'By project',
        generatedAt,
        subtitle: `${report.project.reference} · ${report.project.title}`,
        facts: [
          ['Project', report.project.title],
          ['Reference', report.project.reference],
          ['Organisation', report.project.organisation.name],
          ['Project status', titleCase(report.project.status)],
        ],
        figures: [
          { label: 'Builds', value: report.builds.length, note: 'On this project' },
          { label: 'Testers', value: report.testerCount, note: 'Across every build' },
          { label: 'Test cases', value: report.testCaseCount, note: 'Across every build' },
        ],
        bugs: report.bugs,
        lists: [],
      })
      return xlsxResponse(file, `report-by-project-${fileSlug(report.project.reference)}.xlsx`)
    }

    if (section === 'by-build') {
      if (!buildId) return NextResponse.json({ error: 'Choose a build first' }, { status: 400 })

      const summary = await serverFetch<ByBuildReport>(`reports/by-build/${buildId}`)
      const completion: SummaryFigure =
        // Null is "no test cases to complete", which a bare 0% would misreport as "none done".
        summary.testCaseCompletion === null
          ? { label: 'Test case completion', value: 'Not applicable', note: 'No test cases' }
          : {
              label: 'Test case completion',
              value: summary.testCaseCompletion / 100,
              note: 'Reports filed ÷ test cases',
              format: FORMAT.percent,
            }
      const file = await buildSummaryWorkbook({
        kind: 'By build',
        generatedAt,
        subtitle: 'A single build',
        facts: [['Scope', 'One build']],
        figures: [
          { label: 'Testers', value: summary.testerCount, note: 'Accepted, active or completed' },
          { label: 'Test cases', value: summary.testCaseCount, note: 'Set up for this build' },
          completion,
        ],
        bugs: {
          total: summary.bugCount,
          bySeverity: summary.bugsBySeverity,
          byStatus: summary.bugsByStatus,
          byType: summary.bugsByType,
          byReproducibility: summary.bugsByReproducibility,
        },
        lists: [],
      })
      return xlsxResponse(file, 'report-by-build.xlsx')
    }

    if (section === 'by-date') {
      if (!startDate || !endDate) {
        return NextResponse.json({ error: 'Choose both dates' }, { status: 400 })
      }

      const report = await serverFetch<ByDateReport>('reports/by-date', {
        query: { startDate, endDate },
      })
      const perProject = report.byProject ?? []
      const file = await buildSummaryWorkbook({
        kind: 'By date',
        generatedAt,
        subtitle: `${startDate} to ${endDate}`,
        facts: [
          ['From', startDate],
          ['To', endDate],
          ['Scope', 'Every project on the platform'],
        ],
        figures: [
          { label: 'Projects with bugs', value: perProject.length, note: 'In this period' },
        ],
        bugs: report.bugs,
        lists: [
          {
            sheetName: 'Bugs by project',
            heading: 'Bugs by project',
            headers: ['Reference', 'Project', 'Bugs'],
            numeric: [2],
            rows: perProject.map((entry) => [
              entry.project?.reference ?? '—',
              entry.project?.title ?? 'Deleted project',
              entry.bugCount,
            ]),
            chart: {
              labelColumn: 1,
              valueColumn: 2,
              title: 'Bugs by project',
              valueHeader: 'Bugs',
            },
          },
        ],
      })
      return xlsxResponse(
        file,
        `report-by-date-${fileSlug(startDate)}-to-${fileSlug(endDate)}.xlsx`,
      )
    }

    if (section === 'by-build-range') {
      if (!projectId || !startBuildId || !endBuildId) {
        return NextResponse.json({ error: 'Choose a project and both builds' }, { status: 400 })
      }

      const report = await serverFetch<RangeReport>('reports/by-build-range', {
        query: { projectId, startBuildId, endBuildId },
      })
      const builds = report.builds ?? []
      const file = await buildSummaryWorkbook({
        kind: 'By build range',
        generatedAt,
        subtitle: builds.length > 0 ? `${builds.length} builds` : 'A range of builds',
        facts: [['Scope', 'A range of builds on one project']],
        figures: [
          { label: 'Builds in range', value: builds.length, note: 'Start to end, inclusive' },
        ],
        bugs: report.bugs,
        lists: [
          {
            sheetName: 'Builds in range',
            heading: 'Builds in range',
            headers: ['No.', 'Build'],
            numeric: [0],
            rows: builds.map((b, i) => [i + 1, b.name]),
          },
        ],
      })
      return xlsxResponse(file, 'report-by-build-range.xlsx')
    }

    return NextResponse.json({ error: 'Unknown report' }, { status: 400 })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    if (status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    console.error('[reports] could not be built', error)
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

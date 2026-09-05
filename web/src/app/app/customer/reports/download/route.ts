import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
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
 * `/app/customer/reports/download` — the report on screen, as a CSV.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CONTAIN
 *
 * Aggregate counts only — no per-bug row, no name, no email, no tester
 * identity. `lib/reports/report-csv.ts` carries the full argument for why,
 * and it is worth reading before adding a column here.
 *
 * `testersByCountry` is available on the by-project payload and is left out on
 * purpose — it is not shown on the page, and a per-country head count is
 * weakly identifying once the count is one.
 *
 * ── AUTHORIZATION IS THE API'S
 *
 * Every branch calls the same `/v1/reports/*` endpoint the page itself calls,
 * through `serverFetch` so the session cookie goes with it. `report.generate`
 * resolves through `projectRelations`, so another organisation's project id
 * returns 404 rather than a report. The role check below only keeps
 * non-customers off a customer route; it is not what protects the data.
 */

interface BuildOption {
  id: string
  name: string
}

interface ByProjectReport {
  project: { id: string; reference: string; title: string; status: string }
  builds: BuildOption[]
  testerCount: number
  testCaseCount: number
  bugs: BugBreakdown
}

interface RangeReport {
  bugs: BugBreakdown
  builds?: BuildOption[]
}

export async function GET(request: Request): Promise<Response> {
  const user = await getUser()
  if (user?.role !== 'CUSTOMER') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const params = new URL(request.url).searchParams
  const section = params.get('section') ?? 'by-project'
  const projectId = params.get('projectId') ?? ''
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
      if (!projectId || !startBuildId || !endBuildId) {
        return NextResponse.json({ error: 'Choose a project and both builds' }, { status: 400 })
      }

      const report = await serverFetch<RangeReport>('reports/by-build-range', {
        query: { projectId, startBuildId, endBuildId },
      })
      const builds = report.builds ?? []
      const lines = [
        row('Crowd4Test report'),
        row('Report', 'By build'),
        row('Generated', generated),
        '',
        ...(builds.length > 0
          ? ['Builds in range', row('Build'), ...builds.map((b) => row(b.name)), '']
          : []),
        ...breakdownBlocks(report.bugs),
      ]
      return csvResponse(lines, 'report-by-build.csv')
    }

    if (section === 'by-date') {
      if (!startDate || !endDate) {
        return NextResponse.json({ error: 'Choose both dates' }, { status: 400 })
      }

      const report = await serverFetch<RangeReport>('reports/by-date', {
        query: { startDate, endDate },
      })
      const lines = [
        row('Crowd4Test report'),
        row('Report', 'By date'),
        row('From', startDate),
        row('To', endDate),
        row('Generated', generated),
        '',
        ...breakdownBlocks(report.bugs),
      ]
      return csvResponse(lines, `report-by-date-${slug(startDate)}-to-${slug(endDate)}.csv`)
    }

    return NextResponse.json({ error: 'Unknown report' }, { status: 400 })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // 403 and 404 read the same from here: a customer who cannot see a project
    // should not learn from this route whether it exists.
    if (status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

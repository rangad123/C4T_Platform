import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { buildSummaryWorkbook } from '@/lib/reports/summary-report-xlsx'
import { fileSlug, xlsxResponse } from '@/lib/reports/xlsx-response'
import { titleCase } from '@/lib/reports/xlsx-kit'

export const dynamic = 'force-dynamic'

/**
 * `/app/customer/reports/download` — the report on screen, as an Excel workbook.
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
      if (!projectId || !startBuildId || !endBuildId) {
        return NextResponse.json({ error: 'Choose a project and both builds' }, { status: 400 })
      }

      const report = await serverFetch<RangeReport>('reports/by-build-range', {
        query: { projectId, startBuildId, endBuildId },
      })
      const builds = report.builds ?? []
      const file = await buildSummaryWorkbook({
        kind: 'By build',
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
      return xlsxResponse(file, 'report-by-build.xlsx')
    }

    if (section === 'by-date') {
      if (!startDate || !endDate) {
        return NextResponse.json({ error: 'Choose both dates' }, { status: 400 })
      }

      const report = await serverFetch<RangeReport>('reports/by-date', {
        query: { startDate, endDate },
      })
      const file = await buildSummaryWorkbook({
        kind: 'By date',
        generatedAt,
        subtitle: `${startDate} to ${endDate}`,
        facts: [
          ['From', startDate],
          ['To', endDate],
          ['Scope', 'Your projects'],
        ],
        figures: [],
        bugs: report.bugs,
        lists: [],
      })
      return xlsxResponse(
        file,
        `report-by-date-${fileSlug(startDate)}-to-${fileSlug(endDate)}.xlsx`,
      )
    }

    return NextResponse.json({ error: 'Unknown report' }, { status: 400 })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // 403 and 404 read the same from here: a customer who cannot see a project
    // should not learn from this route whether it exists.
    if (status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    console.error('[reports] could not be built', error)
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

import { NextResponse } from 'next/server'
import { getUser, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { loadBuildReport } from '@/lib/reports/build-report-data'
import { buildReportWorkbook, reportFilename } from '@/lib/reports/build-report-xlsx'
import { xlsxResponse } from '@/lib/reports/xlsx-response'

export const dynamic = 'force-dynamic'

/**
 * `/app/admin/projects/[id]/download` — the build's own report, as an Excel
 * workbook (see `lib/reports/build-report-xlsx.ts` for what is in it).
 *
 * NOT the restore of the export removed platform-wide on 2026-09-02 (see
 * `lib/reports/report-csv.ts` for that history) — a new, separate route with
 * its own, deliberately wider policy, agreed with the person who asked for it
 * rather than inherited from that helper's stricter default.
 *
 * ── WHAT THIS DELIBERATELY DOES CONTAIN, AND WHY THAT'S DIFFERENT HERE
 *
 * Testers and bugs are per-row lists, not just counts — every other report
 * download in this app stops at aggregate figures specifically to avoid
 * exactly this. The difference: this route is reached only from inside one
 * project's own admin page, and a name is exactly what "which testers, which
 * bugs" needs to mean anything. An admin additionally gets each tester's
 * assigned device and browser, which the customer's own page never shows.
 *
 * What it still never contains: email or phone. The admin session does receive
 * `email` on the wire (it is never masked for an admin); the report's types
 * (`ReportPerson`, `BugReport`) do not declare it, so nothing built on them can
 * read it. That is the one thing worth re-checking if this is ever widened.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getUser()
  if (!user || !hasPermission(user, 'project.read')) {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const { id: projectId } = await params
  const buildId = new URL(request.url).searchParams.get('buildId') ?? undefined

  try {
    const report = await loadBuildReport('admin', projectId, buildId)
    const file = await buildReportWorkbook(report)
    return xlsxResponse(file, reportFilename(report))
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    if (status === 400 || status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    console.error('[build report] could not be built', error)
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

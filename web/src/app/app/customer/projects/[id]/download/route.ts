import { NextResponse } from 'next/server'
import { getUser } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { loadBuildReport } from '@/lib/reports/build-report-data'
import { buildReportWorkbook, reportFilename } from '@/lib/reports/build-report-xlsx'
import { xlsxResponse } from '@/lib/reports/xlsx-response'

export const dynamic = 'force-dynamic'

/**
 * `/app/customer/projects/[id]/download` — the build's own report, as an Excel
 * workbook.
 *
 * Customer-side twin of `admin/projects/[id]/download/route.ts` — the same
 * workbook, scoped to the caller's own organisation the same way the page
 * itself is (the project read 404s for a project outside it).
 *
 * ── THE RULE HERE: ONLY WHAT THE CUSTOMER ALREADY SEES ON SCREEN
 *
 * Testers are per-row (name, country, rating, invitation dates — no email, and
 * no assigned device or browser, because the customer's own page never shows
 * those: `loadBuildReport` only writes them for the admin audience). Bugs are
 * in full: everything the customer's own bug page shows — the report as filed,
 * the reporter's NAME, environment, custom answers, comments, status history,
 * attachments.
 *
 * Still never here: email or phone (the report's types do not declare them),
 * signed attachment links, or internal comments (the API filters those out
 * before this route sees them). A customer-facing file carrying contact details
 * is exactly the failure `report-csv.ts` records, so when in doubt the rule is
 * "what is already on screen", not "what the API would allow."
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getUser()
  if (user?.role !== 'CUSTOMER') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const { id: projectId } = await params
  const buildId = new URL(request.url).searchParams.get('buildId') ?? undefined

  try {
    const report = await loadBuildReport('customer', projectId, buildId)
    const file = await buildReportWorkbook(report)
    return xlsxResponse(file, reportFilename(report))
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // 403 and 404 read the same from here: a customer who cannot see a
    // project should not learn from this route whether it exists — matches
    // `customer/reports/download/route.ts`.
    if (status === 400 || status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    console.error('[build report] could not be built', error)
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

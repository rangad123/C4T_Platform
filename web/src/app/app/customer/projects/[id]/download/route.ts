import { NextResponse } from 'next/server'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { bugReportLines, loadBugReport } from '@/lib/reports/bug-report-csv'
import { countBlock, csvResponse, row, slug, titleCase } from '@/lib/reports/report-csv'
import type {
  BuildDetail,
  BuildSummary,
  ProjectAssignmentRow,
  ProjectDetail,
  ProjectMaterial,
} from '../constants'

export const dynamic = 'force-dynamic'

/**
 * `/app/customer/projects/[id]/download` — the build's own report, as a CSV.
 *
 * Customer-side twin of `admin/projects/[id]/download/route.ts` — same
 * seven sections, scoped to the caller's own organisation the same way the
 * page itself is (the project read 404s for a project outside it).
 *
 * ── THE RULE HERE: ONLY WHAT THE CUSTOMER ALREADY SEES ON SCREEN
 *
 * Testers are per-row (name, no email — `ProjectAssignmentRow.tester.email`
 * is typed optional here specifically because the API omits it for a
 * customer caller) and carry no assigned-device/browser columns, because
 * this page's own `ProjectAssignmentRow` never fetches them for a customer.
 *
 * Bugs are `lib/reports/bug-report-csv.ts`, in full: everything the
 * customer's own bug page shows — the report as filed, reporter NAME,
 * environment, custom answers, comments, status history, attachments. An
 * earlier cut left the reporter out because the Bugs LIST table has no such
 * column; the bug page itself does show it, and `maskReporter` keeps the
 * name (never the email) on the wire for a customer caller.
 *
 * Still never here: email or phone (the bug section's types do not declare
 * them), signed attachment links, or internal comments (the API filters
 * those out before this route sees them). A customer-facing CSV carrying
 * contact details is exactly the failure `report-csv.ts` records, so when in
 * doubt the rule is "what is already on screen", not "what the API would
 * allow."
 */

interface FeatureRow {
  id: string
  name: string
  createdAt: string
  _count: { bugs: number }
}

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
    const project = await serverFetch<ProjectDetail>(`projects/${projectId}`, {
      query: { buildId },
    })
    const activeBuildId = project.activeBuildId

    const [build, summary, features, bugReport] = await Promise.all([
      serverFetchOrNull<BuildDetail>(`projects/${projectId}/builds/${activeBuildId}`),
      serverFetchOrNull<BuildSummary>(`builds/${activeBuildId}/summary`),
      serverFetchOrNull<readonly FeatureRow[]>(`projects/${projectId}/features`, {
        query: { buildId: activeBuildId },
      }),
      loadBugReport(projectId, activeBuildId),
    ])

    const generated = new Date().toISOString()

    const lines: string[] = [
      row('Crowd4Test build report'),
      row('Project', `${project.reference} · ${project.title}`),
      row('Organisation', project.organisation.name),
      row('Build', build?.name ?? '—'),
      row('Generated', generated),
      '',
    ]

    if (build) {
      lines.push(
        'Build details',
        row('Field', 'Value'),
        row('Status', titleCase(build.status)),
        row('Test type', build.testType ? titleCase(build.testType) : '—'),
        row('Description', build.description ?? '—'),
        row('App URL', build.appUrl ?? '—'),
        row('Target devices', build.targetDevices.join('; ') || '—'),
        row('Target browsers', build.targetBrowsers.join('; ') || '—'),
        row('Target operating systems', build.targetOperatingSystems.join('; ') || '—'),
        row('Target countries', build.targetCountries.join('; ') || '—'),
        row('Target languages', build.targetLanguages.join('; ') || '—'),
        row('Max testers', build.maxTesters ?? '—'),
        row('Start date', build.startDate ?? '—'),
        row('End date', build.endDate ?? '—'),
        row('Test document attached', build.testDocument ? 'Yes' : 'No'),
        row('Created', build.createdAt),
        row('Updated', build.updatedAt),
        '',
      )
    }

    if (summary) {
      lines.push(
        'Dashboard summary',
        row('Metric', 'Value'),
        row('Testers on roster', summary.testerCount),
        row('Bugs logged', summary.bugCount),
        row('Test cases', summary.testCaseCount),
        row(
          'Test case completion',
          summary.testCaseCompletion === null ? 'Not applicable' : `${summary.testCaseCompletion}%`,
        ),
        row('Reviews', summary.reviewCount),
        row('Average rating', summary.averageRating ?? '—'),
        '',
        ...countBlock('Bugs by severity', 'Severity', summary.bugsBySeverity),
        ...countBlock('Bugs by status', 'Status', summary.bugsByStatus),
        ...countBlock('Bugs by type', 'Type', summary.bugsByType),
        ...countBlock('Bugs by reproducibility', 'Reproducibility', summary.bugsByReproducibility),
        ...countBlock('Test reports by result', 'Result', summary.testReportsByResult),
      )
    }

    const testers = project.assignments
    lines.push(
      `Testers (${testers.length})`,
      row('Name', 'Status', 'Invited', 'Responded', 'Completed', 'Country', 'Rating'),
    )
    if (testers.length === 0) {
      lines.push(row('None recorded'))
    } else {
      for (const assignment of testers) lines.push(testerRow(assignment))
    }
    lines.push('')

    const materials = project.materials
    lines.push(
      `Materials (${materials.length})`,
      row('Title', 'Description', 'URL', 'File', 'Added'),
    )
    if (materials.length === 0) {
      lines.push(row('None recorded'))
    } else {
      for (const material of materials) lines.push(materialRow(material))
    }
    lines.push('')

    const featureList = features ?? []
    lines.push(`Features (${featureList.length})`, row('Name', 'Bugs', 'Added'))
    if (featureList.length === 0) {
      lines.push(row('None recorded'))
    } else {
      for (const f of featureList) lines.push(row(f.name, f._count.bugs, f.createdAt))
    }
    lines.push('')

    lines.push(...bugReportLines(bugReport))

    const filename = `${slug(project.reference)}-${slug(build?.name ?? 'build')}-report.csv`
    return csvResponse(lines, filename)
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // 403 and 404 read the same from here: a customer who cannot see a
    // project should not learn from this route whether it exists — matches
    // `customer/reports/download/route.ts`.
    if (status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

/** Name only — the API never sends `tester.email` to a customer caller in the first place. */
function testerRow(assignment: ProjectAssignmentRow): string {
  const { tester } = assignment
  const name = personName(tester.firstName, tester.lastName)
  return row(
    name,
    titleCase(assignment.status),
    assignment.invitedAt,
    assignment.respondedAt ?? '—',
    assignment.completedAt ?? '—',
    tester.testerProfile?.countryCode ?? '—',
    tester.testerProfile?.ratingAverage ?? '—',
  )
}

function materialRow(material: ProjectMaterial): string {
  return row(
    material.title,
    material.description ?? '—',
    material.url ?? '—',
    material.file?.originalName ?? '—',
    material.createdAt,
  )
}

function personName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || 'Unknown'
}

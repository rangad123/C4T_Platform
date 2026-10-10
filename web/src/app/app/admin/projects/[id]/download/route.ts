import { NextResponse } from 'next/server'
import { serverFetch, serverFetchOrNull, serverFetchPage } from '@/lib/api/server'
import { getUser, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { countBlock, csvResponse, row, slug, titleCase } from '@/lib/reports/report-csv'
import type {
  BuildDetail,
  BuildSummary,
  ProjectAssignmentRow,
  ProjectBugRow,
  ProjectDetail,
  ProjectMaterial,
} from '../constants.js'

export const dynamic = 'force-dynamic'

/**
 * `/app/admin/projects/[id]/download` — the build's own report, as a CSV.
 *
 * NOT the restore of the export removed platform-wide on 2026-09-02 (see
 * `lib/reports/report-csv.ts` for that history) — a new, separate route with
 * its own, deliberately wider policy for two of its seven sections, agreed
 * with the person who asked for it rather than inherited from that helper's
 * stricter default.
 *
 * ── WHAT THIS DELIBERATELY DOES CONTAIN, AND WHY THAT'S DIFFERENT HERE
 *
 * Testers and Bugs are per-row lists, not just counts — every other report
 * download in this app stops at aggregate figures specifically to avoid
 * exactly this. The difference: this route is reached only from inside one
 * project's own admin page (never a customer-facing path, unlike the
 * Reports module, which is why ITS helper stays conservative for everyone
 * who imports it), and a name is exactly what "which testers, which bugs"
 * needs to mean anything.
 *
 * What it still never contains, on either section: email or phone. Both
 * `ProjectAssignmentRow.tester` and `ProjectBugRow.reportedBy` carry `email`
 * on the wire (an admin session is never masked — see `maskReporter` in
 * `bugs.service.ts`), and it is destructured out below and never written to
 * a line. That is the one thing worth re-checking if this file is ever
 * touched again.
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
  if (!user || !hasPermission(user, 'project.read')) {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const { id: projectId } = await params
  const buildId = new URL(request.url).searchParams.get('buildId') ?? undefined

  try {
    // Mirrors the page's own fetch order: the project resolves the active
    // build (the requested `?buildId=`, or the project's default) before
    // anything build-scoped can be fetched.
    const project = await serverFetch<ProjectDetail>(`projects/${projectId}`, {
      query: { buildId },
    })
    const activeBuildId = project.activeBuildId

    const [build, summary, features, bugs] = await Promise.all([
      serverFetchOrNull<BuildDetail>(`projects/${projectId}/builds/${activeBuildId}`),
      serverFetchOrNull<BuildSummary>(`builds/${activeBuildId}/summary`),
      serverFetchOrNull<readonly FeatureRow[]>(`projects/${projectId}/features`, {
        query: { buildId: activeBuildId },
      }),
      fetchAllBugs(projectId, activeBuildId),
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
      row(
        'Name',
        'Status',
        'Invited',
        'Responded',
        'Completed',
        'Assigned device',
        'Assigned browser',
        'Country',
        'Rating',
      ),
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

    lines.push(
      `Bugs (${bugs.length})`,
      row('Reference', 'Title', 'Severity', 'Status', 'Reported by', 'Created'),
    )
    if (bugs.length === 0) {
      lines.push(row('None recorded'))
    } else {
      for (const bug of bugs) lines.push(bugRow(bug))
    }

    const filename = `${slug(project.reference)}-${slug(build?.name ?? 'build')}-report.csv`
    return csvResponse(lines, filename)
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    if (status === 403 || status === 404) {
      return NextResponse.json({ error: 'That report is not available' }, { status: 404 })
    }
    return NextResponse.json({ error: 'The report could not be built' }, { status: 502 })
  }
}

/**
 * Every bug on this build, not just one page of 25 — the admin page itself
 * only ever holds whichever page is on screen, so this loops the same
 * `bugs` list endpoint at the API's own page-size ceiling until exhausted.
 */
async function fetchAllBugs(projectId: string, buildId: string): Promise<ProjectBugRow[]> {
  const all: ProjectBugRow[] = []
  let page = 1
  for (;;) {
    const { data, meta } = await serverFetchPage<ProjectBugRow>('bugs', {
      query: { projectId, buildId, page, limit: 100 },
    })
    all.push(...data)
    if (!meta?.hasNext) break
    page += 1
  }
  return all
}

/** Name only — `tester.email` is on the wire for an admin session and is deliberately left unread here. */
function testerRow(assignment: ProjectAssignmentRow): string {
  const { tester } = assignment
  const name = personName(tester.firstName, tester.lastName)
  const device = assignment.assignedDevice
    ? [assignment.assignedDevice.manufacturer, assignment.assignedDevice.model]
        .filter(Boolean)
        .join(' ') || assignment.assignedDevice.type
    : '—'
  const browser = assignment.assignedBrowser
    ? [assignment.assignedBrowser.browser.name, assignment.assignedBrowser.browserVersion?.version]
        .filter(Boolean)
        .join(' ')
    : '—'
  return row(
    name,
    titleCase(assignment.status),
    assignment.invitedAt,
    assignment.respondedAt ?? '—',
    assignment.completedAt ?? '—',
    device,
    browser,
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

/** Name only — `reportedBy.email` is on the wire for an admin session and is deliberately left unread here. */
function bugRow(bug: ProjectBugRow): string {
  return row(
    bug.reference,
    bug.title,
    titleCase(bug.severity),
    titleCase(bug.status),
    bug.reportedBy ? personName(bug.reportedBy.firstName, bug.reportedBy.lastName) : '—',
    bug.createdAt,
  )
}

function personName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || 'Unknown'
}

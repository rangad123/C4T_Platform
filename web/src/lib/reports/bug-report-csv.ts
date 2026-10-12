import 'server-only'
import { serverFetch, serverFetchPage } from '@/lib/api/server'
import { row, titleCase } from '@/lib/reports/report-csv'

/**
 * The bug half of the per-build report, shared by the admin and customer
 * downloads so the two cannot drift apart.
 *
 * Everything a bug carries is written out: the report as filed, the
 * environment it was captured in, the client's own extra answers, and — as
 * their own sections, keyed by bug reference — its comments, status history
 * and attachments.
 *
 * ── WHAT IS DELIBERATELY NOT HERE
 *
 * Email and phone. `reportedBy` and every comment/history actor arrive on the
 * wire for an admin session with an `email` on them; the interfaces below do
 * not declare that field, so nothing in this file can read it. Keep it that
 * way: widening these types is the decision that needs making on purpose
 * (see `report-csv.ts` for why the old export was removed).
 *
 * Attachment download links are not written either. They are short-lived
 * signed URLs — a bearer credential in a file that gets emailed around — so
 * the file lists each attachment by name, type and size instead.
 *
 * What a caller may see is the API's decision, not this file's: internal
 * comments are filtered out for a customer before they get here, and the
 * bug read 404s outside the caller's own organisation.
 */

interface Person {
  firstName: string | null
  lastName: string | null
}

export interface BugReportRow {
  id: string
  reference: string
  title: string
  description: string
  preCondition: string | null
  stepsToReproduce: string
  expectedResult: string | null
  actualResult: string | null
  severity: string
  status: string
  reproducibility: string
  occurrence: number | null
  outOf: number | null
  videoUrl: string | null
  type: string | null
  feature: { name: string } | null
  deviceModel: string | null
  osName: string | null
  osVersion: string | null
  browser: string | null
  appVersion: string | null
  networkType: string | null
  duplicateOfId: string | null
  triagedAt: string | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  build: { name: string } | null
  reportedBy: (Person & { testerProfile: { countryCode: string | null } | null }) | null
  customValues?: readonly { value: string; field: { name: string; type: string } }[]
  _count: { attachments: number; comments: number }
}

/** What `GET /bugs/:id` adds on top of the list row. */
interface BugDetail {
  duplicateOf: { reference: string } | null
  attachments: readonly {
    caption: string | null
    createdAt: string
    file: {
      originalName: string
      mimeType: string
      sizeBytes: number
      /** Null when the bytes are not in the bucket — the file is gone. */
      downloadUrl: string | null
    }
  }[]
  comments: readonly {
    body: string
    isInternal: boolean
    createdAt: string
    author: (Person & { role: string }) | null
  }[]
  statusHistory: readonly {
    fromStatus: string | null
    toStatus: string
    note: string | null
    createdAt: string
    changedBy: Person | null
  }[]
}

export interface BugReport {
  bugs: readonly BugReportRow[]
  details: ReadonlyMap<string, BugDetail>
  /** References whose comments/history/attachments could not be loaded. */
  incomplete: readonly string[]
}

/** How many `GET /bugs/:id` reads run at once. */
const DETAIL_CONCURRENCY = 10

/**
 * Every bug on the build — all pages of the list, then each bug's own read
 * for the parts the list does not carry. A bug whose read fails is still
 * listed, from the list row, and named in `incomplete` so the file says what
 * it is missing instead of looking whole.
 */
export async function loadBugReport(projectId: string, buildId: string): Promise<BugReport> {
  const bugs: BugReportRow[] = []
  let page = 1
  for (;;) {
    const { data, meta } = await serverFetchPage<BugReportRow>('bugs', {
      query: { projectId, buildId, page, limit: 100 },
    })
    bugs.push(...data)
    if (!meta?.hasNext) break
    page += 1
  }

  const details = new Map<string, BugDetail>()
  const incomplete: string[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < bugs.length) {
      const bug = bugs[next++]!
      try {
        details.set(bug.id, await serverFetch<BugDetail>(`bugs/${bug.id}`))
      } catch {
        incomplete.push(bug.reference)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, bugs.length) }, worker))

  return { bugs, details, incomplete }
}

const NONE = '—'

function personName(person: Person | null | undefined): string {
  if (!person) return NONE
  return [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || 'Unknown'
}

function occurrence(bug: BugReportRow): string {
  return bug.occurrence !== null && bug.outOf !== null ? `${bug.occurrence} of ${bug.outOf}` : NONE
}

/** CHECKBOX answers are stored newline-joined; one line reads better in a cell. */
function answer(value: string): string {
  return value.split(/\r?\n/).filter(Boolean).join('; ')
}

function section(heading: string, header: string, rows: readonly string[]): string[] {
  return [heading, header, ...(rows.length > 0 ? rows : [row('None recorded')]), '']
}

export function bugReportLines(report: BugReport): string[] {
  const { bugs, details } = report
  const sorted = [...bugs].sort((a, b) => a.reference.localeCompare(b.reference))

  const lines: string[] = [
    `Bugs (${bugs.length})`,
    row(
      'Reference',
      'Title',
      'Status',
      'Severity',
      'Type',
      'Reproducibility',
      'Occurrence',
      'Feature',
      'Build',
      'Reported by',
      'Reporter country',
      'Description',
      'Pre-condition',
      'Steps to reproduce',
      'Expected result',
      'Actual result',
      'Video link',
      'Device',
      'OS',
      'OS version',
      'Browser',
      'App version',
      'Network',
      'Duplicate of',
      'Attachments',
      'Comments',
      'Triaged',
      'Resolved',
      'Created',
      'Updated',
    ),
  ]
  if (sorted.length === 0) lines.push(row('None recorded'))
  for (const bug of sorted) {
    const detail = details.get(bug.id)
    lines.push(
      row(
        bug.reference,
        bug.title,
        titleCase(bug.status),
        titleCase(bug.severity),
        bug.type ? titleCase(bug.type) : NONE,
        titleCase(bug.reproducibility),
        occurrence(bug),
        bug.feature?.name ?? NONE,
        bug.build?.name ?? NONE,
        personName(bug.reportedBy),
        bug.reportedBy?.testerProfile?.countryCode ?? NONE,
        bug.description,
        bug.preCondition ?? NONE,
        bug.stepsToReproduce,
        bug.expectedResult ?? NONE,
        bug.actualResult ?? NONE,
        bug.videoUrl ?? NONE,
        bug.deviceModel ?? NONE,
        bug.osName ?? NONE,
        bug.osVersion ?? NONE,
        bug.browser ?? NONE,
        bug.appVersion ?? NONE,
        bug.networkType ?? NONE,
        detail?.duplicateOf?.reference ?? (bug.duplicateOfId ? 'Unavailable' : NONE),
        bug._count.attachments,
        bug._count.comments,
        bug.triagedAt ?? NONE,
        bug.resolvedAt ?? NONE,
        bug.createdAt,
        bug.updatedAt,
      ),
    )
  }
  lines.push('')

  if (report.incomplete.length > 0) {
    lines.push(
      row(
        'Note',
        `Comments, status history and attachments could not be loaded for ${report.incomplete.length} bug(s): ${report.incomplete.join(', ')}`,
      ),
      '',
    )
  }

  const custom: string[] = []
  const comments: string[] = []
  const history: string[] = []
  const attachments: string[] = []
  for (const bug of sorted) {
    for (const value of bug.customValues ?? []) {
      custom.push(
        row(bug.reference, value.field.name, titleCase(value.field.type), answer(value.value)),
      )
    }
    const detail = details.get(bug.id)
    if (!detail) continue
    for (const c of detail.comments) {
      comments.push(
        row(
          bug.reference,
          personName(c.author),
          c.author ? titleCase(c.author.role) : NONE,
          c.isInternal ? 'Yes' : 'No',
          c.createdAt,
          c.body,
        ),
      )
    }
    for (const h of detail.statusHistory) {
      history.push(
        row(
          bug.reference,
          h.fromStatus ? titleCase(h.fromStatus) : NONE,
          titleCase(h.toStatus),
          personName(h.changedBy),
          h.createdAt,
          h.note ?? NONE,
        ),
      )
    }
    for (const a of detail.attachments) {
      attachments.push(
        row(
          bug.reference,
          a.file.originalName,
          a.file.mimeType,
          a.file.sizeBytes,
          a.caption ?? NONE,
          a.createdAt,
          a.file.downloadUrl ? 'Yes' : 'No',
        ),
      )
    }
  }

  lines.push(
    ...section(
      `Bug custom field answers (${custom.length})`,
      row('Bug', 'Field', 'Field type', 'Answer'),
      custom,
    ),
    ...section(
      `Bug comments (${comments.length})`,
      row('Bug', 'Author', 'Role', 'Internal', 'Posted', 'Comment'),
      comments,
    ),
    ...section(
      `Bug status history (${history.length})`,
      row('Bug', 'From', 'To', 'Changed by', 'Changed', 'Note'),
      history,
    ),
    ...section(
      `Bug attachments (${attachments.length})`,
      row('Bug', 'File', 'Type', 'Size (bytes)', 'Caption', 'Added', 'File available'),
      attachments,
    ),
  )
  return lines
}

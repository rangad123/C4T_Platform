import 'server-only'
import { serverFetch, serverFetchPage } from '@/lib/api/server'

/**
 * The bug half of the per-build report's data, shared by the admin and customer
 * downloads so the two cannot drift apart.
 *
 * Everything a bug carries is loaded: the report as filed, the environment it
 * was captured in, the client's own extra answers, and — keyed by bug — its
 * comments, status history and attachments. `build-report-xlsx.ts` lays them out.
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
export interface BugDetail {
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

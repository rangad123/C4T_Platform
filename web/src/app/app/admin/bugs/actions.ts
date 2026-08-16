'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const LIST_PATH = '/app/admin/bugs'

/** Mirrors the API's BugStatus enum. */
const STATUSES = [
  'NEW',
  'TRIAGED',
  'CONFIRMED',
  'IN_PROGRESS',
  'FIXED',
  'VERIFIED',
  'REOPENED',
  'REJECTED',
  'DUPLICATE',
  'WONT_FIX',
  'FEATURE_REQUEST',
] as const

/** Mirrors the API's BugSeverity enum. */
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const

/**
 * Bulk status / severity change for a checked selection of bugs.
 *
 * FormData shape: one or more `ids=<cuid>` fields, plus `status=<status>` and/or
 * `severity=<severity>` and an optional `note`. Anything unrecognised is
 * narrowed to a known enum value rather than passed through, so a tampered
 * form cannot escape the audit trail.
 *
 * The API returns `{ updated: string[], skipped: { id, reason }[] }` —
 * `bulkChangeBugStatus` runs each row through the transition matrix and the
 * per-row relation check, so a single bug that cannot make the requested
 * transition is reported as skipped rather than aborting the batch.
 */
export async function bulkChangeBugStatusAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  // FormData.getAll('ids') returns every checkbox value in submission order,
  // so duplicates (a row selected twice somehow) are kept as-is — the API
  // dedupes via the per-row check anyway.
  const ids = formData.getAll('ids').map((v) => (typeof v === 'string' ? v : '')).filter(Boolean)
  const statusInput = formTrimmed(formData, 'status')
  const severityInput = formTrimmed(formData, 'severity')
  const note = formTrimmed(formData, 'note')

  if (ids.length === 0) return
  const status = (STATUSES as readonly string[]).includes(statusInput) ? statusInput : undefined
  const severity = (SEVERITIES as readonly string[]).includes(severityInput)
    ? severityInput
    : undefined
  if (!status && !severity) return

  const result = await serverFetch<{
    updated: string[]
    skipped: { id: string; reason: string }[]
  }>('bugs/bulk-status', {
    method: 'POST',
    body: {
      ids,
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      ...(note ? { note } : {}),
    },
  })

  // The bulk-status response is informational — every row's outcome is in
  // `updated` and `skipped`. For the moment we don't surface per-row
  // results to the user (would need a flash banner); the page revalidation
  // below is enough for them to see the moved rows.
  void result

  revalidatePath(LIST_PATH)
  // Outside any try/catch on purpose — `redirect` works by throwing.
  redirect(LIST_PATH)
}

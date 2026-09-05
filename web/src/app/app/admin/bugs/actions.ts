'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ApiError } from '@/lib/api/types'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { BUG_SEVERITIES } from '@/lib/domain/enums'

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
const SEVERITIES = BUG_SEVERITIES

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
  const ids = formData
    .getAll('ids')
    .map((v) => (typeof v === 'string' ? v : ''))
    .filter(Boolean)
  const statusInput = formTrimmed(formData, 'status')
  const severityInput = formTrimmed(formData, 'severity')
  const note = formTrimmed(formData, 'note')

  if (ids.length === 0) return
  const status = (STATUSES as readonly string[]).includes(statusInput) ? statusInput : undefined
  const severity = (SEVERITIES as readonly string[]).includes(severityInput)
    ? severityInput
    : undefined
  if (!status && !severity) return

  /*
    The response is the point, not a side effect.

    `updated` and `skipped` are what the API actually did, per row — and this
    used to `void result` and redirect, so selecting ten bugs and moving six
    of them looked identical to moving all ten. The reader was left to spot
    the difference by re-reading the table. Both counts now ride back on the
    URL and are reported.
  */
  let outcome: { updated: string[]; skipped: { id: string; reason: string }[] } | null = null
  let failure: string | null = null
  try {
    outcome = await actionFetch<{
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
  } catch (error) {
    const code = error instanceof ApiError ? error.status : 0
    failure = code === 403 ? 'bulk-forbidden' : code === 422 ? 'bulk-invalid' : 'bulk-failed'
  }

  revalidatePath(LIST_PATH)
  // Outside any try/catch on purpose — `redirect` works by throwing.
  if (failure) redirect(`${LIST_PATH}?notice=${failure}`)
  const params = new URLSearchParams({
    notice: 'bulk-applied',
    moved: String(outcome?.updated.length ?? 0),
    skipped: String(outcome?.skipped.length ?? 0),
  })
  redirect(`${LIST_PATH}?${params.toString()}`)
}

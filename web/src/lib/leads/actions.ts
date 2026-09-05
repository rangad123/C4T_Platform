'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ApiError } from '@/lib/api/types'
/**
 * `actionFetch`, not `serverFetch`.
 *
 * The access cookie lives 15 minutes. `serverFetch` cannot refresh it — it
 * has no way to persist a rotated cookie — so a Server Action using it simply
 * fails once the reader has had the page open longer than that, with no
 * retry. `actionFetch` refreshes and retries once. Every other Server Action
 * in this app already uses it; these did not.
 */
import { actionFetch } from '@/lib/api/action-fetch'
import type { LeadStatusValue } from '@/components/admin/LeadStatusBadge'
import { LEAD_STATUSES } from '@/lib/domain/enums'

/**
 * Server Actions for lead triage.
 *
 * The actions write through the API (which is the only thing that holds the
 * audit log, the ReBAC check, and the write permission gate). They then call
 * `revalidatePath` on the affected pages so the next render sees the new
 * state — list and detail alike.
 *
 * Errors propagate as rejected promises. The forms do not currently surface
 * them in a dedicated UI — for slice A the API's validation is the source of
 * truth, and an invalid submission will silently not change the row, which is
 * the right behaviour for a closed enum.
 */

const LEAD_STATUS_VALUES: readonly LeadStatusValue[] = LEAD_STATUSES

interface LeadResponse {
  data: unknown
}

/** Module-private: a `'use server'` file may only export async functions. */
function leadFailure(error: unknown): string {
  const code = error instanceof ApiError ? error.status : 0
  if (code === 403) return 'lead-forbidden'
  if (code === 404) return 'lead-missing'
  return 'lead-failed'
}

export async function updateLeadStatus(id: string, status: string): Promise<void> {
  if (!LEAD_STATUS_VALUES.includes(status as LeadStatusValue)) {
    throw new Error(`Invalid lead status: ${status}`)
  }

  let notice = 'status-saved'
  try {
    await actionFetch<LeadResponse>(`leads/${id}`, {
      method: 'PATCH',
      body: { status },
    })
  } catch (error) {
    notice = leadFailure(error)
  }

  revalidatePath('/app/admin/leads')
  revalidatePath(`/app/admin/leads/${id}`)
  redirect(`/app/admin/leads/${id}?notice=${notice}`)
}

export async function updateLeadNotes(id: string, notes: string): Promise<void> {
  const trimmed = notes.trim()
  let notice = 'notes-saved'
  try {
    await actionFetch<LeadResponse>(`leads/${id}`, {
      method: 'PATCH',
      body: { notes: trimmed.length > 0 ? trimmed : null },
    })
  } catch (error) {
    notice = leadFailure(error)
  }

  revalidatePath(`/app/admin/leads/${id}`)
  redirect(`/app/admin/leads/${id}?notice=${notice}`)
}

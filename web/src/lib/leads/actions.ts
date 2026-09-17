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

/**
 * Every path through this ends in `redirect()` — including the rejected-value
 * one, which used to `throw` instead. The caller is a form action that does
 * NOT wrap this in a try/catch (wrapping it was the bug that reported every
 * successful save as failed, since `redirect` unwinds by throwing), so a throw
 * from here would now reach the error boundary as a crash screen rather than
 * the notice strip. Unreachable from the form itself — the select only offers
 * real statuses — but the contract has to hold for a hand-made POST too.
 */
export async function updateLeadStatus(id: string, status: string): Promise<void> {
  let notice = 'status-saved'

  if (!LEAD_STATUS_VALUES.includes(status as LeadStatusValue)) {
    notice = 'lead-failed'
  } else {
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
  }

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

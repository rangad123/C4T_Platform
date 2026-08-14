'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import type { LeadStatusValue } from '@/components/admin/LeadStatusBadge'

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

const LEAD_STATUS_VALUES: readonly LeadStatusValue[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'WON',
  'LOST',
  'SPAM',
]

interface LeadResponse {
  data: unknown
}

export async function updateLeadStatus(id: string, status: string): Promise<void> {
  if (!LEAD_STATUS_VALUES.includes(status as LeadStatusValue)) {
    throw new Error(`Invalid lead status: ${status}`)
  }

  await serverFetch<LeadResponse>(`leads/${id}`, {
    method: 'PATCH',
    body: { status },
  })

  revalidatePath('/app/admin/leads')
  revalidatePath(`/app/admin/leads/${id}`)
}

export async function updateLeadNotes(id: string, notes: string): Promise<void> {
  const trimmed = notes.trim()
  await serverFetch<LeadResponse>(`leads/${id}`, {
    method: 'PATCH',
    body: { notes: trimmed.length > 0 ? trimmed : null },
  })

  revalidatePath(`/app/admin/leads/${id}`)
}

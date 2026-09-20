'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formString } from '@/lib/form-data'

const BASE = '/admin/invitations'

interface InviteResult {
  sent: { id: string; email: string }[]
  failed: { id: string; reason: string }[]
}

/**
 * The page to come back to arrives in a form field, so it is not trusted: only
 * this page, with its own filters, is ever a valid destination.
 */
function backTo(raw: string): string {
  return raw === BASE || raw.startsWith(`${BASE}?`) ? raw : BASE
}

function withParams(back: string, params: Record<string, string>): string {
  const [path = BASE, query = ''] = back.split('?')
  const next = new URLSearchParams(query)
  for (const key of ['notice', 'reason', 'sent', 'failed']) next.delete(key)
  for (const [key, value] of Object.entries(params)) next.set(key, value)
  return `${path}?${next.toString()}`
}

/**
 * Emails a sign-in link to everyone ticked on the Invitations page.
 *
 * Safe to repeat: each send cancels the person's previous link, so a second
 * click leaves one working invitation in an inbox, not two.
 */
export async function sendInvitations(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const back = backTo(formString(formData, 'back'))
  const employeeIds = formData
    .getAll('employeeIds')
    .filter((value): value is string => typeof value === 'string' && value !== '')

  if (employeeIds.length === 0) redirect(withParams(back, { notice: 'invite_none' }))

  let result: InviteResult
  try {
    result = await hrActionFetch<InviteResult>('hrms/employees/invitations', {
      method: 'POST',
      body: { employeeIds },
    })
  } catch (error) {
    // A stated refusal is an answer worth reading, not a crash screen.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      redirect(withParams(back, { notice: 'refused', reason: error.message }))
    }
    throw error
  }

  revalidateHrms(BASE)
  redirect(
    withParams(back, {
      notice: 'invited',
      sent: String(result.sent.length),
      failed: String(result.failed.length),
    }),
  )
}

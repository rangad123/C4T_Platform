'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formString, formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the customer's bug detail page.
 *
 * Subset of `admin/bugs/[id]/actions.ts` — only `addBugComment` and
 * `moveBugStatus` (customer's only writable actions per policy.ts: no
 * severity/classification change, no attachment removal, no delete).
 */

const LIST_PATH = '/app/customer/bugs'

const STATUSES: readonly string[] = [
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
]

const NOTE_REQUIRED_STATUSES: readonly string[] = ['REJECTED', 'WONT_FIX']

function detailPath(id: string): string {
  return `${LIST_PATH}/${id}`
}

function failurePath(id: string, panel: string, reason: string): string {
  return `${detailPath(id)}?error=${panel}:${reason}`
}

function reasonFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 404) return 'missing'
    if (error.status === 409) return 'conflict'
    if (error.status === 422) return 'invalid'
  }
  return 'failed'
}

export async function moveBugStatus(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const status = formTrimmed(formData, 'status')
  const note = formTrimmed(formData, 'note')
  const duplicateOfId = formTrimmed(formData, 'duplicateOfId')
  const clearDuplicate = formString(formData, 'clearDuplicate') === 'on'

  if (!status) redirect(failurePath(id, 'status', 'no-change'))
  if (!STATUSES.includes(status)) redirect(failurePath(id, 'status', 'invalid'))
  if (NOTE_REQUIRED_STATUSES.includes(status) && !note) {
    redirect(failurePath(id, 'status', 'note-required'))
  }
  if (status === 'DUPLICATE' && !duplicateOfId) {
    redirect(failurePath(id, 'status', 'duplicate-required'))
  }

  const body: Record<string, unknown> = { status }
  if (note) body.note = note
  if (status === 'DUPLICATE') body.duplicateOfId = duplicateOfId
  else if (clearDuplicate) body.duplicateOfId = null

  let reason: string | null = null
  try {
    await serverFetch(`bugs/${id}/status`, { method: 'POST', body })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'status', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
}

export async function addBugComment(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const body = formTrimmed(formData, 'body')
  if (!body) redirect(failurePath(id, 'comment', 'empty'))

  let reason: string | null = null
  try {
    // A customer can never post internally — the API gates `isInternal` on
    // bug.comment_internal regardless, but omitting the field entirely here
    // means this form never even offers the checkbox to begin with.
    await serverFetch(`bugs/${id}/comments`, { method: 'POST', body: { body, isInternal: false } })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'comment', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
}

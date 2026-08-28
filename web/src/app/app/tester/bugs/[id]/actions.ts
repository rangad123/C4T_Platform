'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for a tester's own bug.
 *
 * What a tester may do to a bug is narrow, and the API decides it — not this
 * file. `GET /bugs/:id` returns a `capabilities` block plus
 * `availableTransitions`, and the page renders controls strictly from those.
 * These actions re-post what the page offered; the API re-checks everything.
 *
 * Deliberately NOT here: severity changes (platform-only), classification
 * (`bug.triage`), and internal comments (`bug.comment_internal`). A tester
 * holds none of those, so no action exists to attempt them.
 */

const LIST_PATH = '/app/tester/bugs'

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
    if (error.status === 422 || error.status === 400) return 'invalid'
  }
  return 'failed'
}

/** Post a comment. Never internal — a tester cannot post one, and the API refuses. */
export async function addBugComment(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const body = formTrimmed(formData, 'body')
  if (!body) redirect(failurePath(id, 'comment', 'empty'))

  let reason: string | null = null
  try {
    await serverFetch(`bugs/${id}/comments`, { method: 'POST', body: { body, isInternal: false } })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'comment', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
  redirect(`${detailPath(id)}?section=comments`)
}

/**
 * Move the bug's status.
 *
 * The transitions a tester actually holds are narrow — the API grants a
 * reporter `FIXED → VERIFIED | REOPENED` and `VERIFIED → REOPENED`, i.e.
 * confirming or rejecting a fix on their own report. The page builds its
 * `<Select>` from `capabilities.availableTransitions` verbatim, so anything
 * reaching here was offered by the API in the first place.
 */
export async function moveBugStatus(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const status = formTrimmed(formData, 'status')
  if (!status) redirect(failurePath(id, 'status', 'no-change'))

  const note = formTrimmed(formData, 'note')

  let reason: string | null = null
  try {
    await serverFetch(`bugs/${id}/status`, {
      method: 'POST',
      body: { status, ...(note ? { note } : {}) },
    })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'status', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
  redirect(detailPath(id))
}

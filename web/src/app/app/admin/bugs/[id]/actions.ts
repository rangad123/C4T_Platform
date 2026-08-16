'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formString, formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for bug triage.
 *
 * EVERY export here is an async function. A `const` or a `type` exported from a
 * `'use server'` module silently unregisters every action in the file, and the
 * forms then fail at runtime with an opaque UnrecognizedActionError — so the
 * enum lists and helpers below stay module-private, and the page keeps its own
 * copy of the option lists it renders.
 *
 * Every action re-authorises. Rendering a form only on a page behind
 * `requireRole` is not a security boundary: an action is a POST endpoint that
 * can be hit without going through the UI at all.
 *
 * FAILURE HANDLING. These are plain `<form action={...}>` submissions with no
 * client state, so there is no `useActionState` to carry an error back. Instead
 * a failed action redirects to the detail page with `?error=<panel>:<reason>`,
 * and the page maps the reason to fixed copy inside the panel that raised it.
 * Only the codes below are ever emitted, and the page renders its own strings
 * for them — nothing from the URL is echoed into the page.
 *
 * A SUCCEEDING action redirects to the clean detail path for the same reason.
 * `revalidatePath` alone re-renders at the *current* URL, so after one failed
 * submit the `?error=` parameter would survive every later save and leave a
 * banner contradicting what just happened.
 */

const LIST_PATH = '/app/admin/bugs'

const SEVERITIES: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

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

/**
 * The two moves the API refuses without a note — `changeBugStatusSchema`'s
 * third refine. Checked here as well so the common mistake comes back as
 * readable copy in the form rather than a 422 hitting the error boundary.
 */
const NOTE_REQUIRED_STATUSES: readonly string[] = ['REJECTED', 'WONT_FIX']

function detailPath(id: string): string {
  return `${LIST_PATH}/${id}`
}

function failurePath(id: string, panel: string, reason: string): string {
  return `${detailPath(id)}?error=${panel}:${reason}`
}

/** Maps an API failure to one of the page's known reason codes. */
function reasonFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 404) return 'missing'
    if (error.status === 409) return 'conflict'
    if (error.status === 422) return 'invalid'
  }
  return 'failed'
}

/**
 * Severity — the triage judgement the API reserves for platform staff.
 *
 * Severity only, deliberately. `POST /bugs/:id/triage` is an alias for
 * `/status` and accepts a `note` too, but the service records the note in
 * `bugStatusHistory` ONLY when the status also changes — a note sent with a
 * severity-only change is accepted and then dropped. Rather than offer a field
 * that silently discards what you typed, the note lives in the status form,
 * which is the only place it is persisted.
 */
export async function triageBugSeverity(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const severity = formTrimmed(formData, 'severity')
  if (!SEVERITIES.includes(severity)) redirect(failurePath(id, 'triage', 'invalid'))

  /*
   * Skip a no-op. The service recomputes `resolvedAt` from the *resulting*
   * status on every call, so re-posting the severity a bug already has would
   * still stamp `resolvedAt` with today's date on an already-resolved bug.
   * `currentSeverity` is a client-supplied hint used only for this shortcut —
   * tampering with it costs a redundant write, nothing more.
   */
  if (severity === formTrimmed(formData, 'currentSeverity')) {
    redirect(failurePath(id, 'triage', 'no-change'))
  }

  let reason: string | null = null
  try {
    await serverFetch(`bugs/${id}/triage`, { method: 'POST', body: { severity } })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'triage', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
}

/**
 * Type and Feature are independent of the lifecycle (`status`) and the
 * platform's judgement (`severity`) — they classify WHAT kind of defect this
 * is and WHICH part of the product it's in, so they go through the plain
 * `PATCH /bugs/:id` update path rather than the triage/status endpoints.
 */
export async function updateBugClassification(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const type = formTrimmed(formData, 'type')
  const featureId = formTrimmed(formData, 'featureId')

  let reason: string | null = null
  try {
    await serverFetch(`bugs/${id}`, {
      method: 'PATCH',
      body: {
        type: type || null,
        featureId: featureId || null,
      },
    })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'triage', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
}

/**
 * A lifecycle move. The page only offers the transitions the API reported in
 * `capabilities.availableTransitions`, but the value is re-checked against the
 * enum here and the API decides legality either way.
 */
export async function moveBugStatus(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

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
  // `duplicateOfId` is only meaningful while the status IS duplicate, so moving
  // a bug out of DUPLICATE offers an explicit opt-in to drop the stale link.
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
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const body = formTrimmed(formData, 'body')
  if (!body) redirect(failurePath(id, 'comment', 'empty'))

  // An internal note is hidden from the customer and the reporter. The API
  // gates it on bug.comment_internal regardless of what is posted here.
  const isInternal = formString(formData, 'isInternal') === 'on'

  let reason: string | null = null
  try {
    await serverFetch(`bugs/${id}/comments`, { method: 'POST', body: { body, isInternal } })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'comment', reason))

  // The comment count is a column on the list, so both paths go stale.
  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
}

export async function removeBugAttachment(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const attachmentId = formTrimmed(formData, 'attachmentId')
  if (!attachmentId) redirect(failurePath(id, 'attachment', 'invalid'))

  let reason: string | null = null
  try {
    await serverFetch<void>(`bugs/${id}/attachments/${attachmentId}`, { method: 'DELETE' })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'attachment', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
}

/**
 * Withdraws the report. A soft delete on the API — `deletedAt` is stamped and
 * the row drops out of every scope.
 *
 * The typed-reference confirmation is the whole safety mechanism: these forms
 * carry no client JavaScript, so there is no `confirm()` dialog to fall back
 * on, and a bare submit button next to a comment box is too easy to hit.
 */
export async function deleteBug(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const reference = formTrimmed(formData, 'reference')
  const confirmation = formTrimmed(formData, 'confirmation')
  if (!reference || confirmation.toUpperCase() !== reference?.toUpperCase()) {
    redirect(failurePath(id, 'delete', 'mismatch'))
  }

  let reason: string | null = null
  try {
    await serverFetch(`bugs/${id}`, { method: 'DELETE' })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'delete', reason))

  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
  // The detail page is gone, so land on the list rather than a 404.
  redirect(LIST_PATH)
}

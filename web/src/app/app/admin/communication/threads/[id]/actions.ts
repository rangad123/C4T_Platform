'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requirePermission, requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for one message thread.
 *
 * EVERY export in this file is an async function, and it has to stay that way:
 * a `'use server'` module that exports a type, a const or a class silently
 * unregisters all of its actions, and the form then fails at runtime with an
 * opaque error rather than at build time. Shared constants below are therefore
 * module-private.
 *
 * Each action re-checks authorization even though the page that renders the
 * form already did — a Server Action is a public endpoint, and the page's own
 * gate proves nothing about who posted to it. The API enforces the same rules
 * again, which is where the audit record and the permission gate actually live.
 */

const LIST_PATH = '/app/admin/communication/threads'

/** Mirrors `postMessageSchema` in the API's communication module. */
const MESSAGE_MAX_LENGTH = 5000

/**
 * Turns an API refusal into one of the page's known reason codes.
 *
 * Module-private, not exported — a `'use server'` module that exports a
 * non-async value silently unregisters every action in the file.
 */
function failureReason(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0
  if (status === 401 || status === 403) return 'denied'
  if (status === 404) return 'missing'
  if (status === 400 || status === 409) return 'closed'
  return 'failed'
}

/**
 * Posts a message into a thread.
 *
 * Attachments are sent as an empty array: the API accepts up to ten file ids,
 * but they must be completed uploads owned by the caller, and the admin panel
 * has no upload surface yet. Sending the empty array keeps the request explicit
 * rather than relying on the schema default.
 */
export async function postThreadMessage(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  const body = formTrimmed(formData, 'body')

  // An empty body is a no-op rather than an error: the API would reject it, and
  // there is nothing useful to tell the reader that the empty textarea has not
  // already told them.
  if (!id || !body) return

  /*
    Over-long messages are refused rather than silently truncated. This used
    to `.slice()` to the limit, so typing past 5,000 characters dropped the
    tail without a word — the writer saw their message posted and had no way
    to know the end of it was gone.
  */
  if (body.length > MESSAGE_MAX_LENGTH) {
    redirect(`${LIST_PATH}/${id}?error=too-long`)
  }

  /*
    Wrapped, because a thread closed in another tab, or an expired session,
    would otherwise throw out of this action into Next's error boundary —
    replacing the conversation with a crash screen and taking the typed
    message with it.
  */
  let reason: string | null = null
  try {
    await actionFetch<{ id: string }>(`communication/threads/${id}/messages`, {
      method: 'POST',
      body: { body, attachmentFileIds: [] },
    })
  } catch (error) {
    reason = failureReason(error)
  }

  revalidatePath(`${LIST_PATH}/${id}`)
  revalidatePath(LIST_PATH)
  if (reason) redirect(`${LIST_PATH}/${id}?error=${reason}`)
}

/**
 * Closes a thread. Admin-side moderation, gated on `communication.write`.
 *
 * There is no reopen route on the API, so this is one-way from the panel's
 * point of view — the confirming copy on the page says so.
 */
export async function closeThread(formData: FormData): Promise<void> {
  await requirePermission('communication.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  let reason: string | null = null
  try {
    await actionFetch<{ id: string; isClosed: boolean }>(`communication/threads/${id}/close`, {
      method: 'POST',
    })
  } catch (error) {
    reason = failureReason(error)
  }

  revalidatePath(`${LIST_PATH}/${id}`)
  revalidatePath(LIST_PATH)
  if (reason) redirect(`${LIST_PATH}/${id}?error=${reason}`)
}

'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
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

  await serverFetch<{ id: string }>(`communication/threads/${id}/messages`, {
    method: 'POST',
    body: {
      body: body.slice(0, MESSAGE_MAX_LENGTH),
      attachmentFileIds: [],
    },
  })

  revalidatePath(`${LIST_PATH}/${id}`)
  revalidatePath(LIST_PATH)
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

  await serverFetch<{ id: string; isClosed: boolean }>(
    `communication/threads/${id}/close`,
    { method: 'POST' },
  )

  revalidatePath(`${LIST_PATH}/${id}`)
  revalidatePath(LIST_PATH)
}

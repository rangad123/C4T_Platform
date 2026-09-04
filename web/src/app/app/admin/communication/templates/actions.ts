'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const LIST_PATH = '/app/admin/communication/templates'

/**
 * Every path that composes a message reads this list, so a change here has to
 * refresh all of them — otherwise a template edited on this page keeps
 * showing its old text in the pickers until something else happens to
 * revalidate them.
 */
const CONSUMERS = [
  LIST_PATH,
  '/app/admin/communication',
  '/app/admin/communication/compose',
  '/app/admin/communication/announcements/new',
] as const

function revalidateAll(): void {
  for (const path of CONSUMERS) revalidatePath(path)
}

/** Maps an API failure to one of the page's known reason codes. */
function reasonFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return 'duplicate'
    if (error.status === 404) return 'missing'
    if (error.status === 401 || error.status === 403) return 'denied'
  }
  return 'failed'
}

export async function createTemplateAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const name = formTrimmed(formData, 'name')
  const subject = formTrimmed(formData, 'subject')
  const body = formTrimmed(formData, 'body')
  if (!name || !body) return

  let reason: string | null = null
  try {
    await actionFetch('communication/templates', {
      method: 'POST',
      body: { name, ...(subject ? { subject } : {}), body },
    })
  } catch (error) {
    reason = reasonFor(error)
  }

  revalidateAll()
  redirect(reason ? `${LIST_PATH}?error=${reason}` : LIST_PATH, 'replace')
}

/**
 * Save an edit.
 *
 * Subject is sent as an empty string rather than omitted when cleared, so
 * "remove this subject" is expressible — omitting it would mean "leave it
 * alone" to the API's partial schema, and the field could never be emptied
 * once set.
 */
export async function updateTemplateAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  const subject = formTrimmed(formData, 'subject')
  const body = formTrimmed(formData, 'body')
  if (!id || !name || !body) return

  let reason: string | null = null
  try {
    await actionFetch(`communication/templates/${id}`, {
      method: 'PATCH',
      body: { name, subject, body },
    })
  } catch (error) {
    reason = reasonFor(error)
  }

  revalidateAll()
  /*
    On failure the modal is reopened on the same template, so the edit is
    still on screen with the reason above it. Redirecting to the bare list
    would close the modal and discard what was typed.

    The attempted name and subject are echoed back, because the failure that
    actually happens here is "that name is taken" — and re-rendering the
    field from the SAVED record would show the reader the old name while
    telling them the new one is a duplicate, leaving them to retype the very
    value they need to change. Both are short and bounded (120 / 200 chars).
    The body is not echoed: it can be 10,000 characters, which does not
    belong in a URL.
  */
  if (reason) {
    const echo = new URLSearchParams({ edit: id, error: reason, name, subject })
    redirect(`${LIST_PATH}?${echo.toString()}`, 'replace')
  }
  redirect(LIST_PATH, 'replace')
}

export async function deleteTemplateAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  if (!id) return

  /*
    Wrapped, unlike before. An unhandled ApiError from a Server Action reaches
    Next's error boundary and replaces the whole page with a crash screen —
    over a refusal ("already deleted in another tab") the reader could simply
    have been told about.
  */
  let reason: string | null = null
  try {
    await actionFetch(`communication/templates/${id}`, { method: 'DELETE' })
  } catch (error) {
    reason = reasonFor(error)
  }

  revalidateAll()
  redirect(reason ? `${LIST_PATH}?error=${reason}` : LIST_PATH, 'replace')
}

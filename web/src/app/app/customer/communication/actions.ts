'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

const BASE = '/app/customer/communication'

/**
 * Posts a reply into a thread.
 *
 * `thread.post` requires `thread:participant`, so the API refuses a thread the
 * caller is not in — this action does not need to check, and could not check
 * as reliably.
 */
export async function postMessageAction(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const threadId = formTrimmed(formData, 'threadId')
  const body = formTrimmed(formData, 'body')
  if (!threadId) return
  if (!body) redirect(`${BASE}?thread=${threadId}&notice=empty`)

  try {
    await serverFetch(`communication/threads/${threadId}/messages`, {
      method: 'POST',
      body: { body },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    redirect(
      `${BASE}?thread=${threadId}&notice=${status === 403 || status === 404 ? 'no-access' : 'failed'}`,
    )
  }

  revalidatePath(BASE)
  redirect(`${BASE}?thread=${threadId}&notice=sent`)
}

/**
 * Starts a conversation about one project.
 *
 * Participants are not chosen by the customer: they come from that project's
 * own contacts, which the API already decides (its managers and the
 * organisation's owners). Letting a client type user ids would be both
 * unusable and a way to probe which ids exist.
 */
export async function startThreadAction(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const projectId = formTrimmed(formData, 'projectId')
  const subject = formTrimmed(formData, 'subject')
  const message = formTrimmed(formData, 'message')

  if (!projectId) redirect(`${BASE}?notice=need-project`)
  if (!message) redirect(`${BASE}?notice=empty`)

  const participantIds = formData.getAll('participantIds').map(String).filter(Boolean)
  if (participantIds.length === 0) redirect(`${BASE}?notice=no-contacts`)

  let thread: { id: string }
  try {
    thread = await serverFetch<{ id: string }>('communication/threads', {
      method: 'POST',
      body: {
        type: 'PROJECT',
        projectId,
        subject: subject || undefined,
        participantIds,
        message,
      },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    redirect(`${BASE}?notice=${status === 403 ? 'no-access' : 'failed'}`)
  }

  revalidatePath(BASE)
  redirect(`${BASE}?thread=${thread.id}&notice=started`)
}

'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

const BASE = '/app/tester/communication'

/**
 * Server Actions for the tester's side of a conversation.
 *
 * Deliberately the same shape as the customer's
 * (`app/customer/communication/actions.ts`) against the same endpoints: a
 * thread has two ends, and giving each end its own semantics is how they
 * drift. `thread.read`/`thread.post` grant to `thread:participant`, which is
 * role-agnostic, so the API needs nothing new to let a tester take part.
 */

/** Posts a reply into a thread the tester is part of. */
export async function postMessageAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const threadId = formTrimmed(formData, 'threadId')
  const body = formTrimmed(formData, 'body')
  if (!threadId) return
  if (!body) redirect(`${BASE}?thread=${threadId}&notice=empty`)

  try {
    await actionFetch(`communication/threads/${threadId}/messages`, {
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
 * Starts a conversation about a project the tester is working on.
 *
 * Participants come from the project's own contacts, exactly as on the
 * customer side — a tester can no more be trusted to type user ids than a
 * customer can, and for the same reason: it would be both unusable and a way
 * to probe which ids exist.
 */
export async function startThreadAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const projectId = formTrimmed(formData, 'projectId')
  const subject = formTrimmed(formData, 'subject')
  const message = formTrimmed(formData, 'message')

  if (!projectId) redirect(`${BASE}?notice=need-project`)
  if (!message) redirect(`${BASE}?notice=empty`)

  const participantIds = formData.getAll('participantIds').map(String).filter(Boolean)
  if (participantIds.length === 0) redirect(`${BASE}?notice=no-contacts`)

  let thread: { id: string }
  try {
    thread = await actionFetch<{ id: string }>('communication/threads', {
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

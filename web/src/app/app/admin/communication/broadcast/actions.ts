'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const LIST_PATH = '/app/admin/communication'
const BROADCAST_PATH = '/app/admin/communication/broadcast'

/**
 * Sends the same message to a selected set of testers as a batch of separate
 * one-to-one conversations.
 *
 * There is no dedicated "broadcast" endpoint on the API — nor should there
 * be. `POST /v1/communication/threads` already creates a thread with a
 * message and a participant list; the only thing missing was the UI to pick
 * many recipients. This action calls that same endpoint once per selected
 * tester with `type: DIRECT` and a single-element `participantIds`, which
 * gives each tester their own private conversation with the sender rather
 * than one shared group thread — a tester should not see who else received
 * the broadcast or how other testers replied to it.
 *
 * Capped at 100 recipients per send: large enough for any realistic cohort,
 * small enough that a runaway "select all" doesn't fire off an unbounded
 * number of sequential requests from a Server Action.
 */
export async function sendBroadcastAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const testerIds = [...new Set(formData.getAll('testerIds').map((v) => (typeof v === 'string' ? v : '')).filter(Boolean))]
  const subject = formTrimmed(formData, 'subject')
  const message = formTrimmed(formData, 'message')

  if (testerIds.length === 0 || message.length === 0) return
  const recipients = testerIds.slice(0, 100)

  // Sequential rather than Promise.all — this is a fan-out of up to 100
  // writes against the same API; running them concurrently from a single
  // Server Action invocation risks tripping the API's per-window rate limit
  // for no real speed benefit (a few seconds either way is invisible next to
  // composing the message).
  let sent = 0
  for (const testerId of recipients) {
    try {
      await serverFetch<{ id: string }>('communication/threads', {
        method: 'POST',
        body: {
          type: 'DIRECT',
          ...(subject ? { subject } : {}),
          participantIds: [testerId],
          message,
        },
      })
      sent++
    } catch {
      // One recipient failing (e.g. the user was deleted between page load
      // and submit) should not stop the rest of the batch from sending.
    }
  }

  revalidatePath(LIST_PATH)
  redirect(`${BROADCAST_PATH}?sent=${sent}&of=${recipients.length}`)
}

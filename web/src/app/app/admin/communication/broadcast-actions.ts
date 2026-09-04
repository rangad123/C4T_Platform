'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'

const BASE = '/app/admin/communication'

/**
 * Composing, saving and sending one message to many testers.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERED
 *
 * This used to be a single action that looped over the selected testers and
 * called `POST /communication/threads` once per recipient, straight from the
 * browser's form submission. That had three problems, none cosmetic:
 *
 *   1. Nothing recorded the SEND. The subject and body existed only as N
 *      copies inside N threads, so "what did I send, to whom, and have they
 *      read it" had no answer — you could only guess by matching timestamps.
 *   2. There were no drafts, because there was nowhere to keep one.
 *   3. The fan-out ran here, one request per recipient, with a 15-minute
 *      access token. A large cohort could outlive the token mid-loop.
 *
 * `POST /communication/broadcasts/:id/send` now owns the fan-out and runs it
 * server-side in one call. It still creates one PRIVATE thread per recipient
 * — that part was always right, and nobody should see who else received a
 * message or how they replied.
 *
 * Everything here goes through `actionFetch`, never `serverFetch`: the access
 * cookie lives 15 minutes and composing a message to a large cohort routinely
 * takes longer than that. `actionFetch` refreshes and retries; `serverFetch`
 * would return 401 and the send would silently do nothing.
 */

export interface ComposeInput {
  subject: string
  body: string
  recipientIds: readonly string[]
  templateId?: string | null
  /** Set when editing an existing draft; absent creates a new one. */
  broadcastId?: string | null
}

export interface ComposeResult {
  ok: boolean
  /** The draft that was written, so the caller can keep editing it. */
  broadcastId?: string
  /** Present on a send. */
  delivered?: number
  failed?: number
  message?: string
}

interface BroadcastPayload {
  id: string
  status: string
  delivered?: number
  failed?: number
}

/**
 * Turns an API refusal into something a person can act on.
 *
 * Without this every 4xx reaches Next's error boundary as an unhandled throw
 * and the composer becomes a crash screen — losing the message that was being
 * written, which is the one thing that cannot be recovered.
 */
function explain(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'Your session is no longer valid. Sign in again — your draft is safe if you saved it.'
    }
    if (error.status === 404) return 'That message no longer exists.'
    if (error.message) return error.message
  }
  return fallback
}

/** Create the draft, or update the one being edited. Never sends. */
async function writeDraft(input: ComposeInput): Promise<BroadcastPayload> {
  const body = {
    subject: input.subject.trim() || undefined,
    body: input.body.trim(),
    templateId: input.templateId ?? null,
    recipientIds: [...new Set(input.recipientIds)],
  }

  return input.broadcastId
    ? actionFetch<BroadcastPayload>(`communication/broadcasts/${input.broadcastId}`, {
        method: 'PATCH',
        body,
      })
    : actionFetch<BroadcastPayload>('communication/broadcasts', { method: 'POST', body })
}

/**
 * Save without sending.
 *
 * Returns rather than redirects: the composer is a client component holding
 * unsaved state, and navigating away from a save would throw away the
 * selection the user is still working on.
 */
export async function saveDraftAction(input: ComposeInput): Promise<ComposeResult> {
  await requirePermission('communication.write')

  if (!input.body.trim()) {
    return { ok: false, message: 'Write the message before saving it.' }
  }

  try {
    const draft = await writeDraft(input)
    revalidatePath(BASE)
    return { ok: true, broadcastId: draft.id }
  } catch (error) {
    return { ok: false, message: explain(error, 'The draft could not be saved. Try again.') }
  }
}

/**
 * Save, then send.
 *
 * Two calls rather than one, deliberately: the draft is written first so that
 * if the send fails the composed message still exists and can be retried from
 * the Drafts list, instead of being lost with the request.
 */
export async function sendBroadcastAction(input: ComposeInput): Promise<ComposeResult> {
  await requirePermission('communication.write')

  if (!input.body.trim()) {
    return { ok: false, message: 'Write the message before sending it.' }
  }
  if (input.recipientIds.length === 0) {
    return { ok: false, message: 'Choose at least one recipient before sending.' }
  }

  let draft: BroadcastPayload
  try {
    draft = await writeDraft(input)
  } catch (error) {
    return { ok: false, message: explain(error, 'The message could not be saved. Try again.') }
  }

  try {
    const sent = await actionFetch<BroadcastPayload>(`communication/broadcasts/${draft.id}/send`, {
      method: 'POST',
    })
    revalidatePath(BASE)
    revalidatePath(`${BASE}/messages/${draft.id}`)
    return {
      ok: true,
      broadcastId: draft.id,
      delivered: sent.delivered ?? 0,
      failed: sent.failed ?? 0,
    }
  } catch (error) {
    return {
      ok: false,
      broadcastId: draft.id,
      message: explain(
        error,
        'The message was saved as a draft but could not be sent. Open it from Drafts and try again.',
      ),
    }
  }
}

/** Discard a draft. A sent message is the record of what went out — the API refuses. */
export async function deleteDraftAction(formData: FormData): Promise<void> {
  await requirePermission('communication.write')

  const raw = formData.get('broadcastId')
  const id = typeof raw === 'string' ? raw : ''
  if (!id) redirect(`${BASE}?tab=DRAFT`)

  try {
    await actionFetch(`communication/broadcasts/${id}`, { method: 'DELETE' })
  } catch (error) {
    /*
      Surfaced on the list rather than thrown: an unhandled ApiError here
      would replace the whole Communication page with a crash screen over a
      refusal the reader can do something about.
    */
    revalidatePath(BASE)
    redirect(
      `${BASE}?tab=DRAFT&error=${encodeURIComponent(explain(error, 'The draft could not be deleted.'))}`,
    )
  }

  revalidatePath(BASE)
  redirect(`${BASE}?tab=DRAFT&deleted=1`)
}

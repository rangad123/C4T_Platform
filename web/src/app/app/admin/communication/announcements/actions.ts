'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ANNOUNCEMENT_AUDIENCES } from '@/lib/domain/enums'

/**
 * Server Actions for announcements.
 *
 * EVERY export here is an async function and must stay that way — a
 * `'use server'` module that also exports a type or a const unregisters all of
 * its actions, and the form then fails at runtime instead of at build time. The
 * audience list below is module-private for exactly that reason; the page keeps
 * its own copy with the reader-facing labels.
 *
 * Both actions re-check `announcement.write` even though the pages that render
 * them already did: a Server Action is a public endpoint, and the API's own gate
 * — which is the one that writes the audit record — is the real boundary.
 */

/**
 * Where a saved announcement lands — the ANNOUNCEMENTS list, not the module
 * root. Publishing one and being dropped on a different tab's list, with no
 * sign of what was just written, reads as though the save failed.
 */
const LIST_PATH = '/app/admin/communication/announcements'

/** Turns an API refusal into one of the pages' known reason codes. */
function failureReason(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0
  if (status === 401 || status === 403) return 'denied'
  if (status === 404) return 'missing'
  if (status === 422) return 'invalid'
  return 'failed'
}

/** Mirrors the AnnouncementAudience enum in the API's Prisma schema. */
const AUDIENCES: readonly string[] = ANNOUNCEMENT_AUDIENCES

/**
 * Creates an announcement, published immediately or held as a draft.
 *
 * The API's `announcementSchema` takes `publishNow: boolean` — NOT a
 * `publishedAt` timestamp. `publishNow: true` stamps `publishedAt` with the
 * server's clock; `false` leaves it null, and the read endpoint filters on
 * `publishedAt: { not: null, lte: now }`, so a draft is invisible to everyone.
 * There is no scheduling: an announcement cannot be dated into the future.
 *
 * `expiresAt` is the only date the schema accepts, coerced with
 * `z.coerce.date()`. It is sent as an ISO string and omitted entirely when
 * blank, because an empty string coerces to an Invalid Date and would earn a
 * 422 rather than being treated as "no expiry".
 */
export async function createAnnouncement(formData: FormData): Promise<void> {
  await requirePermission('announcement.write')

  const title = formTrimmed(formData, 'title')
  const body = formTrimmed(formData, 'body')
  const audienceInput = formTrimmed(formData, 'audience')
  const expiresAtInput = formTrimmed(formData, 'expiresAt')
  // Optional project scope — empty string treated as no scope. CUID length is
  // 25, but the API's zod schema enforces the format anyway, so just trust
  // whatever came back here.
  const projectIdInput = formTrimmed(formData, 'projectId')

  // The API defaults an unknown audience to ALL, which is the widest possible
  // reach — so a tampered value is narrowed here rather than trusted.
  const audience = AUDIENCES.includes(audienceInput) ? audienceInput : 'ALL'

  // Anything other than an explicit draft publishes, matching the schema's
  // `publishNow: z.boolean().default(true)`.
  const publishNow = formTrimmed(formData, 'timing') !== 'draft'

  // The API requires 3+ characters of title and 1+ of body. Bailing out rather
  // than posting a request we know will 422; the fields carry the same limits
  // as native constraints, so this is only reachable by a hand-built post.
  if (title.length < 3 || body.length === 0) return

  // `datetime-local` submits "2026-08-20T09:30" with no zone, which Date reads
  // in the server's local time. Converting to ISO here makes the instant the
  // API stores explicit rather than dependent on how Express parses the string.
  const parsedExpiry = expiresAtInput ? new Date(expiresAtInput) : null
  const expiresAt =
    parsedExpiry !== null && !Number.isNaN(parsedExpiry.getTime())
      ? parsedExpiry.toISOString()
      : null

  /*
    Wrapped, because an unhandled ApiError from a Server Action reaches Next's
    error boundary as a crash screen — and takes the composed announcement
    with it. A refusal here (an expired session, a project the caller cannot
    post to) is something the writer can act on, so it is carried back to the
    composer as a message instead.
  */
  let reason: string | null = null
  try {
    await actionFetch<{ id: string }>('communication/announcements', {
      method: 'POST',
      body: {
        title,
        body,
        audience,
        publishNow,
        ...(projectIdInput ? { projectId: projectIdInput } : {}),
        ...(expiresAt === null ? {} : { expiresAt }),
      },
    })
  } catch (error) {
    reason = failureReason(error)
  }

  revalidatePath(LIST_PATH)
  // Outside any try/catch on purpose — `redirect` works by throwing.
  if (reason) redirect(`${LIST_PATH}/new?error=${reason}`, 'replace')
  redirect(LIST_PATH, 'replace')
}

/**
 * Correct an announcement, and publish a draft.
 *
 * ── THE THREE GAPS THIS CLOSES
 *
 * Announcements could be created and nothing else. A draft could never be
 * published (the API set `publishedAt` only at create time, and had no PATCH
 * and no publish route), nothing could be corrected, and although the API has
 * always had a DELETE route no page ever called it — so the composer's own
 * warning that an announcement "can only be deleted" pointed at something the
 * panel could not do either.
 *
 * The audience is deliberately NOT editable, and the API refuses the field
 * outright: notifications go out once, to the recipient set computed from the
 * audience at publish time, so re-targeting afterwards would leave the
 * notified set and the visible set disagreeing.
 */
export async function updateAnnouncement(formData: FormData): Promise<void> {
  await requirePermission('announcement.write')

  const id = formTrimmed(formData, 'id')
  const title = formTrimmed(formData, 'title')
  const body = formTrimmed(formData, 'body')
  const expiresAtInput = formTrimmed(formData, 'expiresAt')
  if (!id || title.length < 3 || body.length === 0) return

  const parsed = expiresAtInput ? new Date(expiresAtInput) : null
  /*
    Explicit null clears the expiry; omitting it would mean "leave it alone"
    to the API's partial schema, so a set expiry could never be removed.
  */
  const expiresAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null

  const detail = `${LIST_PATH}/${id}`
  let reason: string | null = null
  try {
    await actionFetch(`communication/announcements/${id}`, {
      method: 'PATCH',
      body: { title, body, expiresAt },
    })
  } catch (error) {
    reason = failureReason(error)
  }

  revalidatePath(LIST_PATH)
  revalidatePath(detail)
  redirect(reason ? `${detail}?edit=1&error=${reason}` : detail, 'replace')
}

/**
 * Publish a draft.
 *
 * Separate from editing, because it is a different act: it makes the
 * announcement visible and notifies every reader in its audience, and that
 * cannot be undone from here. The page asks before calling this.
 */
export async function publishAnnouncement(formData: FormData): Promise<void> {
  await requirePermission('announcement.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  const detail = `${LIST_PATH}/${id}`
  let reason: string | null = null
  try {
    await actionFetch(`communication/announcements/${id}`, {
      method: 'PATCH',
      body: { publishNow: true },
    })
  } catch (error) {
    reason = failureReason(error)
  }

  revalidatePath(LIST_PATH)
  revalidatePath(detail)
  redirect(reason ? `${detail}?error=${reason}` : `${detail}?published=1`, 'replace')
}

/** Remove an announcement. The API route existed; nothing ever called it. */
export async function deleteAnnouncement(formData: FormData): Promise<void> {
  await requirePermission('announcement.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  let reason: string | null = null
  try {
    await actionFetch(`communication/announcements/${id}`, { method: 'DELETE' })
  } catch (error) {
    reason = failureReason(error)
  }

  revalidatePath(LIST_PATH)
  redirect(reason ? `${LIST_PATH}/${id}?error=${reason}` : `${LIST_PATH}?deleted=1`, 'replace')
}

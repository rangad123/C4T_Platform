'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

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

const LIST_PATH = '/app/admin/communication'

/** Mirrors the AnnouncementAudience enum in the API's Prisma schema. */
const AUDIENCES: readonly string[] = ['ALL', 'CUSTOMERS', 'TESTERS', 'ADMINS']

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

  await serverFetch<{ id: string }>('communication/announcements', {
    method: 'POST',
    body: {
      title,
      body,
      audience,
      publishNow,
      ...(expiresAt === null ? {} : { expiresAt }),
    },
  })

  revalidatePath(LIST_PATH)
  // Outside any try/catch on purpose — `redirect` works by throwing.
  redirect(LIST_PATH)
}

/**
 * Deletes an announcement outright.
 *
 * The API has no update route, so deletion is the only correction available:
 * a published announcement cannot be edited, unpublished or re-dated.
 */
export async function deleteAnnouncement(formData: FormData): Promise<void> {
  await requirePermission('announcement.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  await serverFetch<void>(`communication/announcements/${id}`, { method: 'DELETE' })

  revalidatePath(LIST_PATH)
}

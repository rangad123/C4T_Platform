import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { resolveNotificationLink } from '@/lib/notifications/resolve-link'

/**
 * `/app/messages/[id]` — where a MESSAGE_RECEIVED notification points.
 *
 * The API cannot name a portal when it writes a notification: one payload
 * goes to many users who may hold different roles, so it writes this
 * portal-agnostic path. Until now nothing served it, and every message
 * notification on the platform was a 404.
 *
 * The redirect happens here because this is the first point at which the
 * reader's role is known. Renders nothing.
 */
export default async function ResolveMessage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params
  redirect(resolveNotificationLink('messages', id, user.role))
}

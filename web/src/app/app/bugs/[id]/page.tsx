import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { resolveNotificationLink } from '@/lib/notifications/resolve-link'

/**
 * `/app/bugs/[id]` — where the bug notifications point.
 *
 * Every bug lives at `/app/{admin,customer,tester}/bugs/:id`; the API writes
 * this portal-agnostic path because one notification payload can reach all
 * three roles. See `resolve-link.ts`. Renders nothing.
 */
export default async function ResolveBug({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params
  redirect(resolveNotificationLink('bugs', id, user.role))
}

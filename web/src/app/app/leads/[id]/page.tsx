import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { resolveNotificationLink } from '@/lib/notifications/resolve-link'

/**
 * `/app/leads/[id]` — where lead notifications point.
 *
 * Leads are admin-side only, so a customer or tester who somehow follows one
 * is sent to their own portal home rather than a 404. See `resolve-link.ts`.
 * Renders nothing.
 */
export default async function ResolveLead({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params
  redirect(resolveNotificationLink('leads', id, user.role))
}

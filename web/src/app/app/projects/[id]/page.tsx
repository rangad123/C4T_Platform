import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { resolveNotificationLink } from '@/lib/notifications/resolve-link'

/**
 * `/app/projects/[id]` — where project notifications point.
 *
 * Portal-agnostic by necessity: a project status change notifies customers
 * and admins together, and they read it at different paths. See
 * `resolve-link.ts`. Renders nothing.
 */
export default async function ResolveProject({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params
  redirect(resolveNotificationLink('projects', id, user.role))
}

import { env } from '@/lib/env'
import type { SidebarSection } from '@/components/admin/Sidebar'
import type { SessionUser } from '@/lib/api/types'

/**
 * Whether this person may open AI Studio: an administrator always, anyone
 * else only with the `ai_studio.access` grant. `/auth/me` returns grants for
 * every role, so customers and testers are read the same way as sub-admins.
 * AI Studio checks the same code again on every request.
 */
export function canOpenAiStudio(user: Pick<SessionUser, 'role' | 'permissions'>): boolean {
  if (user.role === 'ADMIN') return true
  if (user.role === 'USER') return false
  return user.permissions.includes('ai_studio.access')
}

/**
 * Adds the "AI Studio" entry to a portal's sidebar, above Account.
 *
 * It links to `/app/ai-studio` on this site, never straight to AI Studio:
 * that route renews the session and sends a signed-out visitor to sign in
 * first. Shown only when AI_STUDIO_URL is set, because the route answers 404
 * without it, and only to someone who may open AI Studio.
 */
export function withAiStudio(
  sections: readonly SidebarSection[],
  user: Pick<SessionUser, 'role' | 'permissions'>,
): readonly SidebarSection[] {
  if (!env.AI_STUDIO_URL || !canOpenAiStudio(user)) return sections
  const entry: SidebarSection = {
    label: 'Tools',
    links: [{ href: '/app/ai-studio', label: 'AI Studio', icon: 'flask-conical', external: true }],
  }
  const account = sections.findIndex((section) => section.label === 'Account')
  return account < 0
    ? [...sections, entry]
    : [...sections.slice(0, account), entry, ...sections.slice(account)]
}

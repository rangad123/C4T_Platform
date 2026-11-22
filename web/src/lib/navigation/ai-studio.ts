import { env } from '@/lib/env'
import type { SidebarSection } from '@/components/admin/Sidebar'
import { ROLE_HOME, type SessionUser } from '@/lib/api/types'

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

/**
 * `?to=` as the AI Studio page to open, a path such as `/projects/abc`. It
 * becomes the hash of a URL on AI_STUDIO_URL, so it can never name another
 * host; anything that does not look like a path opens AI Studio's home.
 */
function studioPage(to: string | null): string {
  if (!to || !to.startsWith('/') || to.startsWith('//') || to.includes('\\') || to.length > 512) {
    return '/'
  }
  return to
}

/**
 * Where `/app/ai-studio` sends a visitor: on to AI Studio at `to`, to sign in
 * first (and then back to `to`), or their own portal.
 *
 * `user` is `undefined` when the session could not be read at all (the API
 * restarting during a deploy, a rate limit, a dropped connection). That is
 * not a sign-out: sending it to /login made a person type their password
 * again with their session still good. It answers 503 instead, and the
 * visitor reloads.
 */
export function aiStudioHandOff(
  user: Pick<SessionUser, 'role' | 'permissions'> | null | undefined,
  to: string | null,
  studioUrl: string,
): { status: 303 | 307 | 503; location?: string } {
  if (user === undefined) return { status: 503 }
  if (!user) {
    const back = `/app/ai-studio${to ? `?to=${encodeURIComponent(to)}` : ''}`
    return { status: 307, location: `/login?next=${encodeURIComponent(back)}` }
  }
  // An account that has not finished onboarding has no portal, and no AI Studio.
  if (user.role === 'USER') return { status: 307, location: ROLE_HOME.USER }
  /*
    Without `ai_studio.access` the sidebar has no entry, but a bookmark or a
    link from AI Studio still lands here. Back to their own portal home with
    a notice, the way `requireRole` sends a wrong-role visitor home, rather
    than a bare 403 page with no way back.
  */
  if (!canOpenAiStudio(user)) {
    return { status: 307, location: `${ROLE_HOME[user.role]}?notice=ai-studio-no-access` }
  }
  const target = new URL(studioUrl)
  target.hash = studioPage(to)
  return { status: 303, location: target.toString() }
}

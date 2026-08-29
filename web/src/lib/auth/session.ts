import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { serverFetchOrNull } from '@/lib/api/server'
import { ROLE_HOME, type Role, type SessionUser } from '@/lib/api/types'

/**
 * THE authorization boundary.
 *
 * Next 16's own guidance is explicit that Proxy is not where auth belongs, and
 * for this backend that is doubly true: auth is stateful, so verifying a token
 * signature locally proves only that we minted it — not that the session behind
 * it is still live. Only the API knows that.
 *
 * So every protected layout, page and Server Action calls `requireUser()`,
 * which asks the API. `proxy.ts` does nothing more than a cheap cookie-presence
 * redirect for unauthenticated visitors, purely as a UX nicety.
 *
 * `cache()` deduplicates this within a single render pass, so a layout and
 * three nested Server Components asking for the user cost one API call.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const result = await serverFetchOrNull<{ user: SessionUser }>('/auth/me')
  return result?.user ?? null
})

/** Redirects to sign-in when there is no live session. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getUser()
  if (!user) {
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login'
    redirect(target)
  }
  return user
}

/**
 * Requires one of the given roles.
 *
 * Sends the wrong role to *their* home rather than a bare 403 — a Tester who
 * lands on an admin URL has made a navigation mistake, not an attack.
 */
export async function requireRole(roles: Role[], returnTo?: string): Promise<SessionUser> {
  const user = await requireUser(returnTo)
  if (!roles.includes(user.role)) {
    redirect(ROLE_HOME[user.role])
  }
  return user
}

/**
 * Requires a specific permission. ADMIN implicitly holds every permission;
 * SUB_ADMIN is checked against its grants. Mirrors `requirePermission` in the
 * API — the API is still the enforcement point, this only avoids rendering a
 * page the user cannot use.
 */
export async function requirePermission(code: string, returnTo?: string): Promise<SessionUser> {
  const user = await requireUser(returnTo)
  if (user.role === 'ADMIN') return user
  if (user.role !== 'SUB_ADMIN' || !user.permissions.includes(code)) {
    redirect(ROLE_HOME[user.role])
  }
  return user
}

export function hasPermission(user: SessionUser, code: string): boolean {
  if (user.role === 'ADMIN') return true
  if (user.role !== 'SUB_ADMIN') return false
  return user.permissions.includes(code)
}

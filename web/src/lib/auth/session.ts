import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError, ROLE_HOME, type Role, type SessionUser } from '@/lib/api/types'

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

/**
 * "Signed out" and "could not tell" are different answers, and the two
 * callers below need different things from them.
 *
 * A page that REQUIRES a session must not treat a failed read as a logout:
 * that is how a momentary API hiccup used to throw people out of the app
 * mid-task, discarding their work. A page where being signed out is the
 * NORMAL case — /login above all — must not crash when the read fails, or an
 * API outage takes the sign-in form down with it and nobody can get back in.
 *
 * So the read is cached once and reports which of the two it saw; the
 * distinction is drawn by the caller rather than baked into the value.
 */
type SessionRead = { ok: true; user: SessionUser | null } | { ok: false; error: unknown }

const readSession = cache(async (): Promise<SessionRead> => {
  try {
    const result = await serverFetch<{ user: SessionUser }>('/auth/me')
    return { ok: true, user: result?.user ?? null }
  } catch (error) {
    // A 401 is a real answer: there is no session. Anything else — a 502, a
    // dropped connection, a proxy's HTML error page — means we do not know.
    if (error instanceof ApiError && error.status === 401) return { ok: true, user: null }
    return { ok: false, error }
  }
})

/**
 * The non-throwing read. `null` means "not signed in, as far as we can
 * tell" — including when the API could not be reached.
 *
 * Right for pages that merely ask whether someone is signed in, and wrong
 * for pages that depend on the answer: use `requireUser` there.
 */
export const getUser = async (): Promise<SessionUser | null> => {
  const read = await readSession()
  return read.ok ? read.user : null
}

/**
 * Redirects to sign-in when there is no live session — and only then.
 *
 * If the session could not be read at all, the error is rethrown to the
 * segment's `error.tsx`, which offers a retry. Redirecting on an unreadable
 * session is what made an API blip look like a sign-out.
 */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const read = await readSession()
  if (!read.ok) throw read.error

  if (!read.user) {
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login'
    redirect(target)
  }
  return read.user
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

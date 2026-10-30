import { env, isProduction } from '@/lib/env'

/**
 * One sign-in for crowd4test.com and AI Studio (aistudio.crowd4test.com).
 *
 * AI Studio reads this site's session cookie and asks the API whether it is
 * live, so it can only see the cookie when the cookie is scoped to the parent
 * domain. `AUTH_COOKIE_DOMAIN` (".crowd4test.com" in production) does that for
 * the two session cookies, and only for them: the HRMS cookies stay host-only,
 * as `hr-auth.controller.ts` explains. Unset, as in development, every cookie
 * stays host-bound exactly as `authCookieOptions` describes.
 *
 * Framework-free, like `set-cookie.ts`: Proxy writes onto a `NextResponse` and
 * the cookie bridge writes through `next/headers`, and both need these rules.
 *
 * ── THE HOST-ONLY COPIES LEFT FROM BEFORE
 *
 * A browser that signed in before the domain was set holds host-only cookies.
 * Setting a domain cookie of the same name does not replace them: the browser
 * keeps both and sends both, oldest first. Next keeps the last value it parses
 * (the newer one) and forwards only that to the API, so nothing breaks, but
 * the stale copy would outlive a sign-out that deleted the domain cookie. So
 * Proxy expires host-only copies whenever it sees a name twice, and re-scopes
 * a session it has never scoped before (no `c4t_shared` marker yet).
 */

export const SESSION_COOKIE_NAMES = ['c4t_access', 'c4t_refresh'] as const

/**
 * Says "this browser's session cookies are domain cookies". Holds no secret;
 * it only spares Proxy re-issuing the session on every request.
 */
export const SHARED_MARKER_COOKIE = 'c4t_shared'

/** Matches the API's SESSION_ABSOLUTE_TTL: nothing outlives a session's hard ceiling. */
const SESSION_CEILING_SECONDS = 30 * 24 * 60 * 60

export function sessionCookieDomain(): string | undefined {
  return env.AUTH_COOKIE_DOMAIN
}

export function isSessionCookie(name: string): boolean {
  return (SESSION_COOKIE_NAMES as readonly string[]).includes(name)
}

/** The domain a cookie of this name is written under, or none (host-only). */
export function domainFor(name: string): string | undefined {
  return isSessionCookie(name) || name === SHARED_MARKER_COOKIE ? sessionCookieDomain() : undefined
}

/** Session cookie names sent more than once — a host-only copy beside a domain one. */
export function duplicatedSessionCookies(cookieHeader: string): string[] {
  const seen = new Map<string, number>()
  for (const part of cookieHeader.split(';')) {
    const name = part.slice(0, part.indexOf('=')).trim()
    if (isSessionCookie(name)) seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  return [...seen].filter(([, count]) => count > 1).map(([name]) => name)
}

/**
 * A `Set-Cookie` line that expires only the HOST-ONLY copy of `name`. With no
 * Domain attribute it names a different cookie from the domain one, which it
 * leaves alone. Raw, because Next's cookie APIs keep one entry per name and
 * the domain copy may be set in the same response.
 */
export function expireHostOnly(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`
}

/**
 * Seconds until a JWT's `exp`, read WITHOUT verifying. Only for sizing the
 * cookie that carries it when re-scoping: the API verifies every token itself.
 */
export function secondsUntilExpiry(jwt: string, now = Date.now()): number | undefined {
  const payload = jwt.split('.')[1]
  if (!payload) return undefined
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    ).exp
    return typeof exp === 'number' ? Math.max(0, Math.floor(exp - now / 1000)) : undefined
  } catch {
    return undefined
  }
}

export interface SharedCookie {
  name: string
  value: string
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: '/'
  domain: string
  maxAge: number
}

function shared(name: string, value: string, maxAge: number, domain: string): SharedCookie {
  return {
    name,
    value,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    domain,
    maxAge,
  }
}

export function markerCookie(domain: string): SharedCookie {
  return shared(SHARED_MARKER_COOKIE, '1', SESSION_CEILING_SECONDS, domain)
}

/**
 * What Proxy must do to this request's session cookies, if anything:
 * cookies to (re)write under the domain, and host-only copies to expire.
 * `alreadySet` names cookies this response writes anyway (a refresh).
 */
export function sharedSessionFixes(
  cookieHeader: string,
  current: (name: string) => string | undefined,
  alreadySet: readonly string[],
): { set: SharedCookie[]; expire: string[] } {
  const domain = sessionCookieDomain()
  if (!domain) return { set: [], expire: [] }

  const expire = new Set(duplicatedSessionCookies(cookieHeader))
  const set: SharedCookie[] = []
  const present = SESSION_COOKIE_NAMES.filter((name) => current(name))

  if (present.length > 0 && !current(SHARED_MARKER_COOKIE)) {
    for (const name of present) {
      expire.add(name)
      if (alreadySet.includes(name)) continue
      const value = current(name)!
      const maxAge =
        name === 'c4t_access' ? (secondsUntilExpiry(value) ?? 0) : SESSION_CEILING_SECONDS
      // An access token already past its expiry is not worth carrying over:
      // without it, Proxy refreshes on the next navigation.
      if (maxAge > 0) set.push(shared(name, value, maxAge, domain))
    }
    set.push(markerCookie(domain))
  }

  return { set, expire: [...expire] }
}

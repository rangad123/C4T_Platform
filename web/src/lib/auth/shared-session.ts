import { env, isProduction } from '@/lib/env'

/**
 * One sign-in for crowd4test.com and AI Studio (aistudio.crowd4test.com).
 *
 * AI Studio reads this site's access cookie and asks the API whether it is
 * live, so it can only see the cookie when the cookie is scoped to the parent
 * domain. `AUTH_COOKIE_DOMAIN` (".crowd4test.com" in production) does that for
 * the access cookie and the `c4t_shared` marker, and only for them. Unset, as
 * in development, every cookie stays host-bound exactly as `authCookieOptions`
 * describes.
 *
 * ── THE REFRESH COOKIE STAYS ON THIS HOST
 *
 * `c4t_refresh` is a 30-day credential. AI Studio never spends it: when its
 * access cookie has gone it asks this site to renew (`/app/ai-studio/refresh`),
 * and Proxy spends the refresh cookie here. Scoping it to the domain would
 * hand it to every subdomain for nothing, so it is host-only. The HRMS cookies
 * stay host-only too, as `hr-auth.controller.ts` explains.
 *
 * Framework-free, like `set-cookie.ts`: Proxy writes onto a `NextResponse` and
 * the cookie bridge writes through `next/headers`, and both need these rules.
 *
 * ── COPIES LEFT FROM BEFORE
 *
 * A cookie written with a Domain and one written without are two cookies to
 * the browser, even under one name: it keeps both and sends both, oldest
 * first. Next keeps the last value it parses (the newer one), so nothing
 * breaks, but the other copy would outlive a sign-out that deleted only one.
 * Two kinds exist: host-only access cookies from before the domain was set,
 * and domain-scoped refresh cookies from before the refresh cookie stayed on
 * this host. Proxy expires the wrong-scoped copy whenever it sees a name
 * twice, and re-scopes the session of any browser whose `c4t_shared` marker
 * is missing or older than `SHARED_MARKER_VALUE`.
 */

export const SESSION_COOKIE_NAMES = ['c4t_access', 'c4t_refresh'] as const

/**
 * Says "this browser's session cookies are scoped as this file says". Holds
 * no secret; it only spares Proxy re-issuing the session on every request.
 * AI Studio also reads its presence as "this session can be renewed".
 */
export const SHARED_MARKER_COOKIE = 'c4t_shared'

/**
 * The marker's current value. Raise it whenever the scoping rules change, so
 * Proxy revisits browsers that hold an older marker. '1': both session
 * cookies under the domain. '2': the refresh cookie host-only.
 */
export const SHARED_MARKER_VALUE = '2'

/** The cookies written under AUTH_COOKIE_DOMAIN. Never the refresh cookie. */
const DOMAIN_COOKIE_NAMES: readonly string[] = ['c4t_access', SHARED_MARKER_COOKIE]

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
  return DOMAIN_COOKIE_NAMES.includes(name) ? sessionCookieDomain() : undefined
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
 * A `Set-Cookie` line that expires only the copy of `name` scoped to `domain`,
 * leaving the host-only one alone. Raw for the same reason as above.
 */
export function expireUnderDomain(name: string, domain: string): string {
  return `${name}=; Domain=${domain}; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`
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
  /** Absent: host-only. */
  domain?: string
  maxAge: number
}

function shared(
  name: string,
  value: string,
  maxAge: number,
  domain: string | undefined,
): SharedCookie {
  return {
    name,
    value,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    ...(domain ? { domain } : {}),
    maxAge,
  }
}

export function markerCookie(domain: string): SharedCookie {
  return shared(SHARED_MARKER_COOKIE, SHARED_MARKER_VALUE, SESSION_CEILING_SECONDS, domain)
}

/**
 * What Proxy must do to this request's session cookies, if anything: cookies
 * to (re)write in their proper scope, and raw `Set-Cookie` lines expiring the
 * copies in the wrong one. `alreadySet` names cookies this response writes
 * anyway (a refresh). `duplicated` says a name arrived twice, so the cookie
 * header forwarded to the render must be rebuilt with one value per name.
 *
 * `serverAction` is a request that may be a sign-out. A Server Action can
 * write only one cookie per name (Next keys its cookie store by name), so
 * `clearSessionCookies` deletes the host-only refresh cookie and Proxy expires
 * any copy under the domain here, on the same response.
 */
export function sharedSessionFixes(
  cookieHeader: string,
  current: (name: string) => string | undefined,
  alreadySet: readonly string[],
  serverAction = false,
): { set: SharedCookie[]; expire: string[]; duplicated: boolean } {
  const domain = sessionCookieDomain()
  if (!domain) return { set: [], expire: [], duplicated: false }

  const duplicates = duplicatedSessionCookies(cookieHeader)
  const stale = current(SHARED_MARKER_COOKIE) !== SHARED_MARKER_VALUE
  const set: SharedCookie[] = []
  const expire: string[] = []
  let present = false

  for (const name of SESSION_COOKIE_NAMES) {
    const value = current(name)
    if (!value) continue
    present = true
    const twice = duplicates.includes(name)

    if (name === 'c4t_refresh') {
      if (!stale && !twice && !serverAction) continue
      // Whichever copy carried the value in use, it ends up host-only.
      expire.push(expireUnderDomain(name, domain))
      if ((stale || twice) && !alreadySet.includes(name)) {
        set.push(shared(name, value, SESSION_CEILING_SECONDS, undefined))
      }
      continue
    }

    if (!stale && !twice) continue
    expire.push(expireHostOnly(name))
    if (!stale || alreadySet.includes(name)) continue
    const maxAge = secondsUntilExpiry(value) ?? 0
    // An access token already past its expiry is not worth carrying over:
    // without it, Proxy refreshes on the next navigation.
    if (maxAge > 0) set.push(shared(name, value, maxAge, domain))
  }

  if (present && stale) set.push(markerCookie(domain))

  return { set, expire, duplicated: duplicates.length > 0 }
}

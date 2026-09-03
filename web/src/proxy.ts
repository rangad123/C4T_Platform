import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { spendRefreshToken } from '@/lib/auth/refresh-core'
import { authCookieOptions, parseSetCookie } from '@/lib/auth/set-cookie'
import { authHeaders } from '@/lib/auth/request-context'

/**
 * Next 16 Proxy — formerly `middleware.ts`.
 *
 * THIS IS NOT THE AUTHORIZATION BOUNDARY. Read that again before adding
 * anything to it.
 *
 * Next's own docs say a matcher change or a refactor can silently remove Proxy
 * coverage, and that authentication must be verified inside each layout, page
 * and Server Function regardless. On top of that, this platform's auth is
 * STATEFUL: a signed token proves only that the API minted it, never that the
 * session behind it is still live. Only the API can answer that.
 *
 * So the access check here is a cookie-presence check, to spare a signed-out
 * visitor a pointless round trip to a page that would only redirect them. The
 * real check is `requireUser()` in src/lib/auth/session.ts.
 *
 * Deliberately no JWKS verification here. It would look reassuring, cost a
 * network fetch on every request, and still not tell us the session is alive.
 *
 * ── The one thing here that is NOT a presence check, and why it belongs
 *
 * Renewing an expired access token is a mechanical exchange, not an
 * authorization decision: it says nothing about who may see what, and every
 * page still asks the API who the user is afterwards. It has to happen here
 * because it cannot happen anywhere else on a navigation — a Server Component
 * render cannot set cookies, so it could rotate the token and then lose it,
 * which the API reads as replay and answers by destroying the session.
 * Proxy runs before rendering and can still set cookies, so it is the only
 * correct place for it. See `refreshIfExpired` below.
 */

const ACCESS_COOKIE = 'c4t_access'
const REFRESH_COOKIE = 'c4t_refresh'

/** Signed-in users have no business on these. */
const GUEST_ONLY = ['/login', '/register', '/forgot-password']

/**
 * Renews an expired access token so a navigation doesn't sign the user out.
 *
 * Fires only in the one state that needs it: the access cookie is gone (it
 * carries `Max-Age=900`, so the browser drops it 15 minutes after it was
 * minted) while the refresh cookie is still present. That state is otherwise
 * a guaranteed bounce to /login, even though the session behind it is good
 * for up to 30 days.
 *
 * A successful refresh costs one API call per 15 minutes per user, because
 * the rotated access cookie immediately puts the request back into the
 * common "has access cookie, do nothing" branch. Concurrent requests from
 * one navigation share a single exchange — see `spendRefreshToken`, where
 * that sharing is load-bearing rather than an optimisation.
 *
 * Returns true when the request may proceed as signed-in. On failure it
 * returns false and the caller falls through to the usual redirect, so a
 * genuinely dead session still signs out exactly as before.
 */
async function refreshIfExpired(
  request: NextRequest,
): Promise<ReturnType<typeof authCookieOptions>[]> {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value
  if (!refreshToken) return []

  const cookieHeader = request.headers.get('cookie') ?? ''
  const setCookies = await spendRefreshToken(
    refreshToken,
    cookieHeader,
    authHeaders(request.headers),
  )
  if (!setCookies || setCookies.length === 0) return []

  const isProduction = env.NEXT_PUBLIC_ENVIRONMENT === 'production'
  const applied: ReturnType<typeof authCookieOptions>[] = []
  for (const raw of setCookies) {
    const parsed = parseSetCookie(raw)
    if (!parsed) continue
    const options = authCookieOptions(parsed, isProduction)
    applied.push(options)
    // Onto the forwarded request too, so the render happening *now* sees the
    // new access token rather than running with the expired jar and
    // redirecting anyway. The caller puts them on the response.
    request.cookies.set(options.name, options.value)
  }
  return applied
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl

  /**
   * Canonicalise path casing — for PAGES ONLY.
   *
   * The old site used PascalCase paths (`/Pricing`, `/Contact`, `/Services`),
   * and Next's filesystem routing is case-SENSITIVE, so those inbound links
   * 404. The obvious fix — a config redirect — does not work when the path
   * differs from its destination only by case: redirect `source` matching is
   * case-INSENSITIVE, so the rule matches its own destination and loops.
   *
   * Here the comparison is exact, so it is safe. This also covers every stray
   * capitalisation the legacy map never enumerated.
   *
   * ── STATIC FILES ARE EXEMPT, and the exemption is not cosmetic
   *
   * A file served from `public/` keeps whatever case its filename has, and the
   * filesystem serves it case-sensitively. Lowercasing the request redirects it
   * to a name that does not exist, so the asset 404s. Worse, the failure does
   * not look like a routing problem: `next/image` fetches the original path,
   * follows the redirect into a 404, and reports `400 Bad Request` from
   * `/_next/image` — which points at the optimizer, not at this file.
   *
   * That is exactly what a client-supplied `C4T_Landing_Page.png` did on the
   * homepage hero. The matcher below already excludes `_next/*` and the
   * well-known files, but nothing stopped an ordinary public asset with a
   * capital letter in its name from being rewritten out of existence.
   *
   * The test is a dot in the LAST segment — i.e. a file extension. Page routes
   * in this app never contain one; every static asset does.
   *
   * ── OPAQUE TOKENS ARE EXEMPT TOO, for the identical reason
   *
   * `/invitations/:token` carries `generateOpaqueToken()` — 32 random bytes as
   * base64url (api/src/lib/tokens.ts) — directly in the path, and only the
   * token's HASH is stored. base64url is case-sensitive by design (A-Z, a-z,
   * 0-9, -, _): of 20 tokens generated to check this, 20 contained an
   * uppercase letter. Lowercasing one before it reaches the page changes what
   * hashes to, which cannot match the row created from the original — every
   * invitation link this platform sends was one redirect away from looking
   * expired to its recipient, with nothing in the response to say why.
   *
   * Every OTHER dynamic segment in this app is either a Prisma `cuid()`
   * (lowercase by construction) or a `[slug]` the API already constrains to
   * `/^[a-z0-9]+(-[a-z0-9]+)*$/` — both already equal their own lowercase
   * form, so this redirect was always a no-op for them. Naming the one route
   * that actually needed the exemption, rather than loosening the check
   * generally, keeps the legacy-path fix above doing only what it says.
   */
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  const isStaticFile = lastSegment.includes('.')
  const isOpaqueTokenPath = pathname.startsWith('/invitations/')

  const lower = pathname.toLowerCase()
  if (!isStaticFile && !isOpaqueTokenPath && pathname !== lower) {
    const url = request.nextUrl.clone()
    url.pathname = lower
    return NextResponse.redirect(url, 308)
  }

  // Presence only. The value is never trusted or decoded here.
  const hasSession = request.cookies.has(ACCESS_COOKIE) || request.cookies.has(REFRESH_COOKIE)

  /**
   * Renew before rendering when the access cookie has aged out but the
   * session behind it has not. Confined to `/app` — the marketing site never
   * reads a session, so refreshing for it would be a round trip bought for
   * nothing.
   */
  let refreshed: ReturnType<typeof authCookieOptions>[] = []
  if (
    pathname.startsWith('/app') &&
    !request.cookies.has(ACCESS_COOKIE) &&
    request.cookies.has(REFRESH_COOKIE)
  ) {
    refreshed = await refreshIfExpired(request)
  }

  if (pathname.startsWith('/app') && !hasSession) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('next', `${pathname}${search}`)
    return NextResponse.redirect(url)
  }

  /**
   * Bounce a signed-in visitor off the guest-only pages — but NEVER when the
   * URL carries `?next=`.
   *
   * ── The redirect loop this guard exists to prevent
   *
   * `hasSession` above is a cookie-PRESENCE check; it deliberately never
   * validates the token. `requireUser()` in the page validates LIVENESS by
   * asking the API. When a cookie is present but the session behind it is dead
   * — expired, revoked, or signed by a previous deployment — the two
   * permanently disagree, and without this guard they ping-pong:
   *
   *     /app          → page: session dead   → /login?next=/app
   *     /login?next=  → proxy: cookie there  → /app
   *     /app          → page: session dead   → /login?next=/app        …forever
   *
   * The browser gives up with ERR_TOO_MANY_REDIRECTS, and because the loop
   * never renders anything the user sees a blank screen first.
   *
   * A `next` parameter is the tell: it is only ever set by a page-level check
   * that has just rejected this request. Honouring a presence-only cookie at
   * that exact moment is what closes the cycle, so we stand down and let
   * `/login` render. The page itself re-checks with the API and redirects a
   * genuinely live session onward — the correct layer for that decision,
   * since only the API can answer it.
   */
  const isGuestOnly = GUEST_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  const arrivedFromAuthCheck = request.nextUrl.searchParams.has('next')

  if (hasSession && isGuestOnly && !arrivedFromAuthCheck) {
    const url = request.nextUrl.clone()
    url.pathname = '/app'
    url.search = ''
    return NextResponse.redirect(url)
  }

  /**
   * Forward the full current path (with query string) to `app/layout.tsx`
   * via a request header, for one purpose only: the `next` target of a
   * session-expiry redirect, so re-signing in returns to the page the
   * visitor was actually on instead of a hardcoded `/app`. (The sidebar's
   * active-link highlight used to be threaded through a sibling
   * `x-pathname` header too, but that only ever reflected the URL at the
   * moment the admin layout last mounted — layouts don't re-render on a
   * client-side navigation within their own segment, so every sidebar click
   * left the highlight stuck on stale. `Sidebar` now reads `usePathname()`
   * itself instead, which is the client hook built for exactly this.)
   */
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-full-path', `${pathname}${search}`)
  // `request.cookies.set` above updated the request's own jar; mirror it onto
  // the headers actually forwarded to the render, so this request is served
  // with the fresh access token rather than the expired one.
  if (refreshed.length > 0) requestHeaders.set('cookie', request.cookies.toString())

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  for (const options of refreshed) response.cookies.set(options)
  return response
}

export const config = {
  /**
   * Without a matcher this runs on every request including static assets, which
   * would mean auth logic in front of your CSS. Exclude the API rewrite too —
   * the Express service does its own authorisation and does not need a redirect
   * to an HTML page.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|og/).*)'],
}

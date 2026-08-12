import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

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
 * So all this does is a cookie-presence check to spare a signed-out visitor a
 * pointless round trip to a page that would only redirect them. The real check
 * is `requireUser()` in src/lib/auth/session.ts.
 *
 * Deliberately no JWKS verification here. It would look reassuring, cost a
 * network fetch on every request, and still not tell us the session is alive.
 */

const ACCESS_COOKIE = 'c4t_access'
const REFRESH_COOKIE = 'c4t_refresh'

/** Signed-in users have no business on these. */
const GUEST_ONLY = ['/login', '/register', '/forgot-password']

export function proxy(request: NextRequest): NextResponse {
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
   */
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  const isStaticFile = lastSegment.includes('.')

  const lower = pathname.toLowerCase()
  if (!isStaticFile && pathname !== lower) {
    const url = request.nextUrl.clone()
    url.pathname = lower
    return NextResponse.redirect(url, 308)
  }

  // Presence only. The value is never trusted or decoded here.
  const hasSession = request.cookies.has(ACCESS_COOKIE) || request.cookies.has(REFRESH_COOKIE)

  if (pathname.startsWith('/app') && !hasSession) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('next', `${pathname}${search}`)
    return NextResponse.redirect(url)
  }

  if (hasSession && GUEST_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone()
    url.pathname = '/app'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
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

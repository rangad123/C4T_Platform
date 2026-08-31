import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { bridgeApiCookies } from '@/lib/auth/cookie-bridge'
import { safeNextOrHome } from '@/lib/safe-redirect'

/**
 * GET /auth/google/complete — where the API's Google OAuth callback sends the
 * browser once sign-in succeeds, carrying a one-time `code` instead of a real
 * session.
 *
 * WHY THIS EXISTS: the API and this web app are on unrelated origins in a
 * split deploy (see `lib/oauth/handoff.ts` on the API for the full reasoning).
 * The API's callback necessarily runs on its OWN origin — Google redirects
 * there, not here — so any cookie it set directly would be invisible to this
 * app, which is the one every page actually checks for a session. Instead,
 * this route exchanges the code for the real tokens server-to-server (this
 * server calling `API_ORIGIN` directly, the browser is not involved in that
 * leg) and bridges the resulting `Set-Cookie` onto ITS OWN response — the
 * exact same `bridgeApiCookies` password login already uses in
 * `lib/auth/actions.ts`. From the browser's point of view, this is the one
 * request that actually receives the session cookies.
 *
 * The code is short-lived and single-use (enforced on the API side), so
 * sitting briefly in a URL is an accepted, standard trade-off — the same
 * shape as the `code` Google itself hands back to the API's own callback.
 *
 * ── WHY THE REDIRECTS ARE RELATIVE
 *
 * These used to be `new URL(path, request.url)`. Behind a reverse proxy
 * `request.url` is the address the PROXY used to reach this server, not the
 * one the visitor typed — on the single-box nginx deployment that is
 * `localhost:3000`, with the scheme taken from `x-forwarded-proto`. Every
 * redirect from here therefore pointed at `https://localhost:3000`, which is
 * a host that speaks no TLS: the browser reported a protocol error and the
 * whole thing looked like the API had sent the user somewhere absurd.
 *
 * A relative `Location` avoids the question entirely. RFC 7231 allows it and
 * every browser resolves it against the URL it actually requested, which is
 * the public one by definition. Nothing to configure, and nothing to get
 * wrong in a second deployment shape.
 */

/**
 * A redirect that does not need to know its own public address.
 *
 * `NextResponse.redirect` insists on an absolute URL, which is the trap this
 * route fell into, so the header is set directly. Cookies bridged by
 * `bridgeApiCookies` ride along regardless: it writes to Next's cookie store,
 * not to a response object.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location: path } })
}
export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code')
  const target = safeNextOrHome(request.nextUrl.searchParams.get('target'))

  if (!code) {
    return redirectTo('/login?error=google_failed')
  }

  let response: Response
  try {
    response = await fetch(new URL('/v1/auth/google/exchange', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    })
  } catch {
    return redirectTo('/login?error=network')
  }

  if (!response.ok) {
    // Expired, already used (a double-click, a refreshed tab, a crawler
    // that followed the link), or tampered with — either way, restart.
    return redirectTo('/login?error=google_failed')
  }

  await bridgeApiCookies(response)
  return redirectTo(target)
}

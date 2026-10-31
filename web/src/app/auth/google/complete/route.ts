import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import { bridgeApiCookies } from '@/lib/auth/cookie-bridge'
import { sessionCookieDomain } from '@/lib/auth/shared-session'
import { safeNextOrHome } from '@/lib/safe-redirect'
import { authHeaders } from '@/lib/auth/request-context'

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
 * ── THE CODE ONLY WORKS IN THE BROWSER THAT SIGNED IN
 *
 * The API's callback also writes `c4t_oauth_handoff` on the browser it
 * redirects here, and redeems the code only with that cookie's value
 * (`lib/oauth/handoff.ts` on the API). Without it, someone could finish a
 * Google sign-in with their own account and send the link to someone else,
 * whose browser would then be signed into the sender's account. The cookie is
 * deleted here whatever happens: it is good for one code.
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

/**
 * Written by the API (`OAUTH_HANDOFF_COOKIE` in auth.controller.ts) under its
 * COOKIE_DOMAIN, which is the same parent domain as AUTH_COOKIE_DOMAIN here.
 */
const HANDOFF_COOKIE = 'c4t_oauth_handoff'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code')
  const target = safeNextOrHome(request.nextUrl.searchParams.get('target'))
  const binding = request.cookies.get(HANDOFF_COOKIE)?.value

  const cookieStore = await cookies()
  const domain = sessionCookieDomain()
  if (binding)
    cookieStore.delete({ name: HANDOFF_COOKIE, path: '/', ...(domain ? { domain } : {}) })

  if (!code) {
    return redirectTo('/login?error=google_failed')
  }

  let response: Response
  try {
    response = await fetch(new URL('/v1/auth/google/exchange', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(request.headers) },
      body: JSON.stringify(binding ? { code, binding } : { code }),
      cache: 'no-store',
    })
  } catch (error) {
    console.error('[auth/google/complete] exchange unreachable', error)
    return redirectTo('/login?error=network')
  }

  if (!response.ok) {
    /**
     * Expired, already used (a double-click, a refreshed tab, a crawler that
     * followed the link), or tampered with — either way, restart.
     *
     * Logged because the screen cannot say more than "that did not work": the
     * reader has no way to act on the difference and the body may describe
     * internals. Without this the only symptom of a handoff that never
     * matches — the failure mode a second API worker produces — is a generic
     * message and nothing anywhere to explain it, which cost most of a night.
     */
    console.error('[auth/google/complete] exchange refused', {
      status: response.status,
      body: await response.text().catch(() => ''),
    })
    return redirectTo('/login?error=google_failed')
  }

  await bridgeApiCookies(response)
  return redirectTo(target)
}

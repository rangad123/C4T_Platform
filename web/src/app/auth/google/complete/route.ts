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
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code')
  const target = safeNextOrHome(request.nextUrl.searchParams.get('target'))

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=google_failed', request.url))
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
    return NextResponse.redirect(new URL('/login?error=network', request.url))
  }

  if (!response.ok) {
    // Expired, already used (a double-click, a refreshed tab, a crawler
    // that followed the link), or tampered with — either way, restart.
    return NextResponse.redirect(new URL('/login?error=google_failed', request.url))
  }

  await bridgeApiCookies(response)
  return NextResponse.redirect(new URL(target, request.url))
}

import { NextResponse } from 'next/server'

/**
 * AI Studio's silent renewal.
 *
 * The access cookie lives 15 minutes. When it has gone, AI Studio requests
 * this path in the background (`fetch(..., { mode: 'no-cors', credentials:
 * 'include' })`) and retries. Proxy does the actual work on the way in: it
 * spends the refresh cookie and writes the rotated access cookie under the
 * parent domain, which AI Studio then sees. The refresh cookie stays on this
 * host (`lib/auth/shared-session.ts`), so AI Studio never receives it. Renewal therefore stays in one place,
 * with Proxy's one-refresh-per-token guard, rather than AI Studio spending the
 * same refresh token and tripping the API's replay detection.
 *
 * Nothing is returned: the response is opaque to AI Studio anyway. A visitor
 * with no session is redirected to sign-in by Proxy before reaching here.
 */
export function GET(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

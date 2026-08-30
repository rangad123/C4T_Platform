import 'server-only'
import { cookies } from 'next/headers'
import { applySetCookies } from '@/lib/auth/cookie-bridge'
import { spendRefreshToken } from '@/lib/auth/refresh-core'

/**
 * Refreshes the session from a Server Action, persisting the rotated cookies.
 *
 * ── Why this exists at all
 *
 * The access cookie's lifetime is `JWT_ACCESS_TTL` — 15 minutes, confirmed on
 * the wire as `Max-Age=900`. The API has always had a complete
 * `POST /v1/auth/refresh` (rotation, reuse detection, a sliding idle window
 * capped by a 30-day absolute expiry), but nothing on this side ever called
 * it. So a session the API considered good for weeks died in the browser
 * after fifteen minutes, and the next Server Action a user submitted bounced
 * them to /login with their work discarded.
 *
 * ── Why it may only be called from a Server Action or Route Handler
 *
 * `cookies().set()` throws outside a Server Function/Route Handler, because
 * HTTP cannot set cookies once a render has begun streaming. That makes a
 * refresh during a Server Component render not merely useless but actively
 * destructive: the API would rotate, the new token would be dropped on the
 * floor, and the next request would present the superseded one — which the
 * API answers by destroying the session. Navigation-time refresh is handled
 * in `proxy.ts` instead, which runs before rendering and can still set
 * cookies.
 */
export async function attemptRefresh(): Promise<boolean> {
  const cookieStore = await cookies()
  const refreshToken = cookieStore.get('c4t_refresh')?.value
  if (!refreshToken) return false

  const setCookies = await spendRefreshToken(refreshToken, cookieStore.toString())
  if (!setCookies || setCookies.length === 0) return false

  // Applied per request even when this call joined an in-flight refresh: the
  // rotated cookies have to land on *this* response to reach the browser.
  await applySetCookies(setCookies)
  return true
}

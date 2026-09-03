import { env } from '@/lib/env'

/**
 * Spending a refresh token for a rotated pair, deduplicated per token.
 *
 * Framework-free so both callers can share ONE in-flight map: Proxy (which
 * writes cookies onto a `NextResponse`) and Server Actions (which write
 * through `next/headers`). Next 16's Proxy runs on the Node.js runtime, the
 * same process Server Actions run in, so module scope genuinely is shared
 * between them — which is what makes a single map correct rather than
 * wishful.
 *
 * ── The deduplication is not an optimisation. Without it, refreshing is
 *    unsafe.
 *
 * The API rotates on every refresh and keeps the superseded hash in
 * `previousTokenHash`. Presenting that superseded value is treated as a
 * captured-and-replayed token and the session is DESTROYED outright, not
 * tolerated as a benign overlap. Verified directly against the running API:
 * refresh once, then replay the old token — the response is
 * "This session was ended for security reasons", and the *new* token is dead
 * too.
 *
 * So two requests racing with the same cookie do not merely waste a round
 * trip: the first rotates, the second replays, and the user is signed out of
 * every tab for a security incident they never caused. A single navigation
 * can easily issue several requests at once (the document, an RSC payload,
 * link prefetches), so this race is the common case, not a corner one.
 *
 * Sharing one promise per token means concurrent callers spend it exactly
 * once and all apply the same rotated cookies.
 */
const inFlight = new Map<string, Promise<string[] | null>>()

/**
 * How long a settled result stays joinable. Long enough for requests that
 * arrived together to share one rotation, short enough that a genuine later
 * refresh (15+ minutes on) always makes its own call.
 */
const JOIN_WINDOW_MS = 10_000

/**
 * Exchanges a refresh token for a rotated cookie pair.
 *
 * Returns the raw `Set-Cookie` headers for the caller to store in whatever
 * way its context allows, or `null` when the session cannot be refreshed —
 * expired, revoked, reused, or the API being unreachable. `null` is not by
 * itself proof the user is signed out; callers decide that from the original
 * request's own status.
 *
 * `authHeaders` carries the visitor's real `user-agent`/IP through to the
 * API (see `request-context.ts`) — without it, every silent refresh re-stamps
 * the session's device info back to this server's own loopback address,
 * *overwriting* whatever correct value login originally recorded. Optional,
 * and only used on the branch that actually makes the call: a caller joining
 * an in-flight exchange already under way rides whichever context the first
 * caller sent. That is never wrong in practice — every realistic concurrent
 * caller here is the same browser's own overlapping requests, so they would
 * have sent the same values anyway — and this data is informational display
 * only, never a security decision.
 */
export function spendRefreshToken(
  refreshToken: string,
  cookieHeader: string,
  authHeaders: Record<string, string> = {},
): Promise<string[] | null> {
  const existing = inFlight.get(refreshToken)
  if (existing) return existing

  const attempt = (async (): Promise<string[] | null> => {
    let response: Response
    try {
      response = await fetch(new URL('/v1/auth/refresh', env.API_ORIGIN), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          ...authHeaders,
        },
        body: '{}',
        cache: 'no-store',
      })
    } catch {
      // API unreachable. Not an auth failure — see the `null` note above.
      return null
    }

    if (!response.ok) return null
    return typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : null
  })()

  inFlight.set(refreshToken, attempt)
  void attempt.finally(() => {
    const timer = setTimeout(() => inFlight.delete(refreshToken), JOIN_WINDOW_MS)
    // Never hold the process open just to expire a cache entry.
    timer.unref?.()
  })
  return attempt
}

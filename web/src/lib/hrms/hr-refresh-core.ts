import { env } from '@/lib/env'

/**
 * HRMS's own refresh-token spend — structural copy of
 * `lib/auth/refresh-core.ts`'s `spendRefreshToken`, targeting
 * `/v1/hrms/auth/refresh` with its own dedup map. A separate map (not a
 * shared one keyed differently) because HR and platform refresh tokens are
 * different token spaces from different sessions tables — nothing is gained
 * by sharing the map, and a bug that let one namespace's key collide with
 * the other's would be a real cross-domain leak in exactly the system this
 * whole module exists to keep separate.
 *
 * See the platform original for the full reasoning on why the
 * deduplication is a correctness requirement, not an optimisation: the API
 * treats a superseded refresh token as a replayed/captured one and destroys
 * the session outright, so two requests racing on the same cookie must
 * share one rotation, not each spend it.
 */
const inFlight = new Map<string, Promise<string[] | null>>()
const JOIN_WINDOW_MS = 10_000

export function spendHrRefreshToken(
  refreshToken: string,
  cookieHeader: string,
  authHeaders: Record<string, string> = {},
): Promise<string[] | null> {
  const existing = inFlight.get(refreshToken)
  if (existing) return existing

  const attempt = (async (): Promise<string[] | null> => {
    let response: Response
    try {
      response = await fetch(new URL('/v1/hrms/auth/refresh', env.API_ORIGIN), {
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
    timer.unref?.()
  })
  return attempt
}

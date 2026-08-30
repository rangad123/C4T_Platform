import 'server-only'
import { serverFetch, type ServerRequestOptions } from './server'
import { ApiError } from './types'
import { attemptRefresh } from '@/lib/auth/refresh'

/**
 * `serverFetch` for Server Actions, with one refresh-and-retry on an expired
 * access token.
 *
 * ── Why this is a separate function rather than a flag on `serverFetch`
 *
 * The two callers differ in what they are *allowed* to do, not in what they
 * want. A Server Component render cannot set cookies, so it must never
 * refresh (see `lib/auth/refresh.ts` for why a discarded rotation is worse
 * than no rotation at all). A Server Action can. Encoding that as an option
 * on the shared helper would put the burden of knowing the rule on every
 * call site; a separate import that is only correct in one context makes the
 * rule enforceable by review.
 *
 * ── Why only one retry, and only on this one error
 *
 * `isRetryableAuthFailure` is true only for a 401 whose code is
 * `UNAUTHORIZED` — the API's documented "expired access token" case. A
 * revoked, idle-expired or reused session returns a different code and will
 * fail again after any number of refreshes, so retrying those would just
 * delay the sign-out the user actually needs.
 *
 * Concurrent callers are safe because `attemptRefresh` shares one in-flight
 * refresh per token — which it must, since the API destroys a session that
 * sees its superseded token replayed. See the note in `lib/auth/refresh.ts`.
 */
export async function actionFetch<T>(path: string, options: ServerRequestOptions = {}): Promise<T> {
  try {
    return await serverFetch<T>(path, options)
  } catch (error) {
    if (!(error instanceof ApiError) || !error.isRetryableAuthFailure) throw error
    if (!(await attemptRefresh())) throw error
    return await serverFetch<T>(path, options)
  }
}

import { ApiError } from '@/lib/api/types'

/**
 * Whether a failed session read means "could not tell" rather than an answer:
 * a dropped connection or a page that is not the API's (not an ApiError), a
 * 5xx during a deploy, or a 429. Any other refusal, a 403 for a suspended or
 * deactivated account above all, is definite and must not be retried for
 * ever. Kept apart from `session.ts` (server-only) so it can be tested.
 */
export function couldNotTell(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 429
}

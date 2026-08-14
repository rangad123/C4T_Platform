'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError, type ActiveSession } from '@/lib/api/types'
import { formString, formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the admin's own account — `/app/admin/profile`.
 *
 * Four writes, each mapped to exactly one API call:
 *
 *   saveProfile          → PATCH  users/me
 *   changePassword       → POST   auth/change-password
 *   revokeSession        → DELETE auth/sessions/:id
 *   signOutEverywhere    → POST   auth/logout-all
 *
 * FEEDBACK CHANNEL. Every path ends in a `redirect()` back to the page with
 * `?ok=` or `?error=` — the same query-param echo the sign-in form uses. That
 * keeps all four forms Server Components: no `useFormState`, no client state,
 * and a failed submit is a normal navigation the browser can reload.
 *
 * NOTHING BUT ASYNC FUNCTIONS MAY BE EXPORTED FROM THIS FILE. A `'use server'`
 * module is an RPC boundary; exporting a type or a const silently unregisters
 * every action in it and each form then fails with an opaque
 * `UnrecognizedActionError` that names the form, not the offending export.
 * Shared shapes are imported from `@/lib/api/types` instead.
 */

const PROFILE_PATH = '/app/admin/profile'

/** Cookie names must match the API's ACCESS_COOKIE / REFRESH_COOKIE. */
const ACCESS_COOKIE = 'c4t_access'
const REFRESH_COOKIE = 'c4t_refresh'

function back(slug: string, kind: 'ok' | 'error'): never {
  redirect(`${PROFILE_PATH}?${kind}=${slug}`)
}

/**
 * Clears the cookies this app bridged from the API, for the two actions that
 * end the caller's own session.
 *
 * The API expires its own copies on its response, but that response goes to the
 * Next.js server, not to the browser — so the browser would keep sending a
 * cookie whose session row is already revoked, and every page would render a
 * redirect to sign-in instead of simply landing there.
 */
async function clearBridgedCookies(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(ACCESS_COOKIE)
  cookieStore.delete(REFRESH_COOKIE)
}

/**
 * Edits the admin's own profile.
 *
 * The writable set is `updateOwnProfileSchema` on the API, which is
 * `updateUserSchema` verbatim: firstName, lastName, phone, countryCode,
 * timezone, avatarFileId. Role and status are deliberately absent from it —
 * an own-profile PATCH cannot escalate anybody.
 *
 * `avatarFileId` is not offered here: it is an upload id, not something anyone
 * types into a text field.
 */
export async function saveProfile(formData: FormData): Promise<void> {
  const firstName = formTrimmed(formData, 'firstName')
  const lastName = formTrimmed(formData, 'lastName')
  const phone = formTrimmed(formData, 'phone')
  const countryCode = formTrimmed(formData, 'countryCode').toUpperCase()
  const timezone = formTrimmed(formData, 'timezone')

  if (!firstName) back('name_required', 'error')

  /**
   * The API types `countryCode` as exactly two characters, so an empty string
   * is a validation failure rather than a clear. Omitting the key leaves the
   * stored value alone, which is the honest reading of "not supplied".
   */
  if (countryCode && countryCode.length !== 2) back('country_code', 'error')

  // lastName, phone and timezone have no minimum length on the API, so an
  // empty string is a real clear rather than a rejected value.
  const body: Record<string, string> = { firstName, lastName, phone, timezone }
  if (countryCode) body.countryCode = countryCode

  let failure: string | null = null
  try {
    await serverFetch('users/me', { method: 'PATCH', body })
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) failure = 'profile_invalid'
    else if (error instanceof ApiError && error.status === 403) failure = 'profile_forbidden'
    else failure = 'profile_failed'
  }

  if (failure) back(failure, 'error')

  revalidatePath(PROFILE_PATH)
  back('profile', 'ok')
}

/**
 * Changes the admin's own password.
 *
 * `changePasswordSchema` is `{ currentPassword, newPassword }` — there is no
 * confirmation field on the API, and there should not be: a typo check belongs
 * to the form that collected the typo. So the match is checked here, before the
 * request, and reported through the same `?error=` channel as everything else.
 *
 * The API keeps THIS session and revokes every other one, so the sessions table
 * on the page changes as a side effect — hence the revalidate before redirect.
 */
export async function changePassword(formData: FormData): Promise<void> {
  const currentPassword = formString(formData, 'currentPassword')
  const newPassword = formString(formData, 'newPassword')
  const confirmPassword = formString(formData, 'confirmPassword')

  if (!currentPassword || !newPassword) back('password_missing', 'error')
  if (newPassword !== confirmPassword) back('password_mismatch', 'error')
  // Mirrors the API's own minimum. Checked here only so the reply is instant.
  if (newPassword.length < 12) back('password_short', 'error')
  if (newPassword === currentPassword) back('password_reused', 'error')

  let failure: string | null = null
  try {
    await serverFetch('auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    })
  } catch (error) {
    if (error instanceof ApiError) {
      // 400 is the Google-only account with no password to replace; 401 here is
      // "current password is incorrect", not a dead session — the page itself
      // would have redirected to sign-in if the session had gone.
      if (error.status === 400) failure = 'password_google'
      else if (error.status === 401) failure = 'password_wrong'
      else if (error.status === 422) failure = 'password_weak'
      else failure = 'password_failed'
    } else {
      failure = 'password_failed'
    }
  }

  if (failure) back(failure, 'error')

  revalidatePath(PROFILE_PATH)
  back('password', 'ok')
}

/**
 * Ends one session.
 *
 * Whether the target is the caller's own device is read from the API rather
 * than from the form, so a tampered hidden field cannot make the app skip
 * clearing its cookies and leave the browser holding a revoked token.
 */
export async function revokeSession(formData: FormData): Promise<void> {
  const sessionId = formTrimmed(formData, 'sessionId')
  if (!sessionId) back('session_missing', 'error')

  let wasCurrent = false
  try {
    const sessions = await serverFetch<ActiveSession[]>('auth/sessions')
    wasCurrent = sessions.some((session) => session.id === sessionId && session.isCurrent)
  } catch {
    // Unreadable list — fall through and let the delete below be the real
    // check. Worst case the caller sees the page again and reloads.
  }

  let failure: string | null = null
  try {
    await serverFetch(`auth/sessions/${sessionId}`, { method: 'DELETE' })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) failure = 'session_missing'
    else if (error instanceof ApiError && error.status === 403) failure = 'session_forbidden'
    else failure = 'session_failed'
  }

  if (failure) back(failure, 'error')

  if (wasCurrent) {
    await clearBridgedCookies()
    redirect('/login')
  }

  revalidatePath(PROFILE_PATH)
  back('session_revoked', 'ok')
}

/**
 * Ends every session, this one included.
 *
 * `POST auth/logout-all` without `?keepCurrent=true` revokes the caller's own
 * row too, so there is no page left to revalidate — sending the browser to
 * /login is the only coherent next step. Revalidating instead would render the
 * profile page for a session that no longer authenticates anything, and the
 * admin would watch it bounce to sign-in a moment later anyway.
 */
export async function signOutEverywhere(): Promise<void> {
  try {
    await serverFetch('auth/logout-all', { method: 'POST' })
  } catch {
    // Even an unreachable API must not strand the admin on a page they believe
    // they have just signed out of. Clear locally and go to sign-in.
  }

  await clearBridgedCookies()
  redirect('/login')
}

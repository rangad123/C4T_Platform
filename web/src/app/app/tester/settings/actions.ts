'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError, type ActiveSession } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formString, formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the tester's own account settings.
 *
 * Same shape as `admin/profile/actions.ts` — these endpoints are all
 * "me"-scoped and role-agnostic, so the only differences are the redirect
 * targets and the role gate.
 */

const SETTINGS_PATH = '/app/tester/settings'

/** Must match the API's ACCESS_COOKIE / REFRESH_COOKIE. */
const ACCESS_COOKIE = 'c4t_access'
const REFRESH_COOKIE = 'c4t_refresh'

function back(slug: string, kind: 'ok' | 'error', section?: 'sessions'): never {
  const sectionParam = section ? `section=${section}&` : ''
  redirect(`${SETTINGS_PATH}?${sectionParam}${kind}=${slug}`)
}

/**
 * Clears the cookies this app bridged from the API.
 *
 * The API expires its own copies on its response, but that response goes to
 * the Next server, not the browser — so without this the browser keeps
 * sending a cookie whose session row is already revoked, and every page
 * renders a redirect to sign-in instead of simply landing there.
 */
async function clearBridgedCookies(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(ACCESS_COOKIE)
  cookieStore.delete(REFRESH_COOKIE)
}

export async function changePassword(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const currentPassword = formString(formData, 'currentPassword')
  const newPassword = formString(formData, 'newPassword')
  const confirmPassword = formString(formData, 'confirmPassword')

  if (!currentPassword || !newPassword) back('password_missing', 'error')
  // The typo check belongs to the form that collected the typo — the API has
  // no confirmation field.
  if (newPassword !== confirmPassword) back('password_mismatch', 'error')
  if (newPassword.length < 12) back('password_short', 'error')
  if (newPassword === currentPassword) back('password_reused', 'error')

  let failure: string | null = null
  try {
    await actionFetch('auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    })
  } catch (error) {
    if (error instanceof ApiError) {
      // 400 is a Google-only account with no password to replace; 401 here is
      // "current password wrong", not a dead session — the page itself would
      // have redirected to sign-in if the session had gone.
      if (error.status === 400) failure = 'password_google'
      else if (error.status === 401) failure = 'password_wrong'
      else if (error.status === 422) failure = 'password_weak'
      else failure = 'password_failed'
    } else {
      failure = 'password_failed'
    }
  }

  if (failure) back(failure, 'error')

  revalidatePath(SETTINGS_PATH)
  back('password', 'ok')
}

/**
 * Ends one session.
 *
 * Whether the target is this browser is read from the API rather than the
 * form, so a tampered hidden field cannot make the app skip clearing its
 * cookies and leave the browser holding a revoked token.
 */
export async function revokeSession(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const sessionId = formTrimmed(formData, 'sessionId')
  if (!sessionId) back('session_missing', 'error', 'sessions')

  let wasCurrent = false
  try {
    const sessions = await actionFetch<ActiveSession[]>('auth/sessions')
    wasCurrent = sessions.some((session) => session.id === sessionId && session.isCurrent)
  } catch {
    // Unreadable list — let the delete below be the real check.
  }

  let failure: string | null = null
  try {
    await actionFetch(`auth/sessions/${sessionId}`, { method: 'DELETE' })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) failure = 'session_missing'
    else if (error instanceof ApiError && error.status === 403) failure = 'session_forbidden'
    else failure = 'session_failed'
  }

  if (failure) back(failure, 'error', 'sessions')

  if (wasCurrent) {
    await clearBridgedCookies()
    redirect('/login')
  }

  revalidatePath(SETTINGS_PATH)
  back('session_revoked', 'ok', 'sessions')
}

/**
 * Ends every session, this one included — so there is no page left to
 * revalidate and /login is the only coherent next step.
 */
export async function signOutEverywhere(): Promise<void> {
  await requireRole(['TESTER'])

  try {
    await actionFetch('auth/logout-all', { method: 'POST' })
  } catch {
    // Even an unreachable API must not strand someone on a page they believe
    // they have just signed out of. Clear locally and go to sign-in.
  }

  await clearBridgedCookies()
  redirect('/login')
}

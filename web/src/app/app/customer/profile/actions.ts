'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError, type ActiveSession } from '@/lib/api/types'
import { formString, formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the customer's own account — `/app/customer/profile`.
 * Direct copy of `admin/profile/actions.ts`: every call here is scoped to
 * "me" and does not branch on role, so this is a redirect-target change only.
 */

const PROFILE_PATH = '/app/customer/profile'

const ACCESS_COOKIE = 'c4t_access'
const REFRESH_COOKIE = 'c4t_refresh'

function back(slug: string, kind: 'ok' | 'error', section?: 'password' | 'sessions'): never {
  const sectionParam = section ? `section=${section}&` : ''
  redirect(`${PROFILE_PATH}?${sectionParam}${kind}=${slug}`)
}

async function clearBridgedCookies(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(ACCESS_COOKIE)
  cookieStore.delete(REFRESH_COOKIE)
}

export async function saveProfile(formData: FormData): Promise<void> {
  const firstName = formTrimmed(formData, 'firstName')
  const lastName = formTrimmed(formData, 'lastName')
  const phone = formTrimmed(formData, 'phone')
  const countryCode = formTrimmed(formData, 'countryCode').toUpperCase()
  const timezone = formTrimmed(formData, 'timezone')

  if (!firstName) back('name_required', 'error')
  if (countryCode && countryCode.length !== 2) back('country_code', 'error')

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

export async function changePassword(formData: FormData): Promise<void> {
  const currentPassword = formString(formData, 'currentPassword')
  const newPassword = formString(formData, 'newPassword')
  const confirmPassword = formString(formData, 'confirmPassword')

  if (!currentPassword || !newPassword) back('password_missing', 'error', 'password')
  if (newPassword !== confirmPassword) back('password_mismatch', 'error', 'password')
  if (newPassword.length < 12) back('password_short', 'error', 'password')
  if (newPassword === currentPassword) back('password_reused', 'error', 'password')

  let failure: string | null = null
  try {
    await serverFetch('auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    })
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 400) failure = 'password_google'
      else if (error.status === 401) failure = 'password_wrong'
      else if (error.status === 422) failure = 'password_weak'
      else failure = 'password_failed'
    } else {
      failure = 'password_failed'
    }
  }

  if (failure) back(failure, 'error', 'password')

  revalidatePath(PROFILE_PATH)
  back('password', 'ok', 'password')
}

export async function revokeSession(formData: FormData): Promise<void> {
  const sessionId = formTrimmed(formData, 'sessionId')
  if (!sessionId) back('session_missing', 'error', 'sessions')

  let wasCurrent = false
  try {
    const sessions = await serverFetch<ActiveSession[]>('auth/sessions')
    wasCurrent = sessions.some((session) => session.id === sessionId && session.isCurrent)
  } catch {
    // Unreadable list — fall through and let the delete below be the real check.
  }

  let failure: string | null = null
  try {
    await serverFetch(`auth/sessions/${sessionId}`, { method: 'DELETE' })
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

  revalidatePath(PROFILE_PATH)
  back('session_revoked', 'ok', 'sessions')
}

export async function signOutEverywhere(): Promise<void> {
  try {
    await serverFetch('auth/logout-all', { method: 'POST' })
  } catch {
    // Even an unreachable API must not strand the customer on a page they
    // believe they have just signed out of. Clear locally and go to sign-in.
  }

  await clearBridgedCookies()
  redirect('/login')
}

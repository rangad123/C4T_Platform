'use server'

import { redirect, RedirectType } from 'next/navigation'
import { env } from '@/lib/env'
import { formString, formTrimmed } from '@/lib/form-data'
import { currentAuthHeaders } from '@/lib/auth/request-context'

/**
 * Forgot/reset password for HRMS. Kept out of `hr-actions.ts` for the same
 * reason `hr-profile-actions.ts` is: that file is the login/logout boundary,
 * and these two run unauthenticated.
 *
 * Neither action reports whether an address matched an employee — the API
 * answers 204 either way, and so does this.
 */

export async function hrForgotPasswordAction(formData: FormData): Promise<void> {
  const email = formTrimmed(formData, 'email')
  if (!email) redirect('/forgot-password?error=missing', RedirectType.replace)

  try {
    const response = await fetch(new URL('/v1/hrms/auth/forgot-password', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await currentAuthHeaders()) },
      body: JSON.stringify({ email }),
      cache: 'no-store',
    })
    // 429 is the one failure worth surfacing: silently claiming "check your
    // inbox" when the request was rate-limited leaves someone waiting for mail
    // that was never sent.
    if (response.status === 429) {
      redirect('/forgot-password?error=rate_limited', RedirectType.replace)
    }
  } catch {
    redirect('/forgot-password?error=network', RedirectType.replace)
  }

  redirect('/forgot-password?sent=1', RedirectType.replace)
}

export async function hrResetPasswordAction(formData: FormData): Promise<void> {
  const token = formString(formData, 'token')
  const password = formString(formData, 'password')
  const confirmPassword = formString(formData, 'confirmPassword')
  const back = (error: string) =>
    `/reset-password?token=${encodeURIComponent(token)}&error=${error}`

  if (!token) redirect('/reset-password?error=missing_token', RedirectType.replace)
  if (!password) redirect(back('missing'), RedirectType.replace)
  if (password !== confirmPassword) redirect(back('mismatch'), RedirectType.replace)

  let response: Response
  try {
    response = await fetch(new URL('/v1/hrms/auth/reset-password', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await currentAuthHeaders()) },
      body: JSON.stringify({ token, password }),
      cache: 'no-store',
    })
  } catch {
    redirect(back('network'), RedirectType.replace)
  }

  if (!response.ok) {
    // 400 covers an expired, already-used or unknown link — all of which mean
    // "ask for a new one", so they share a message.
    redirect(back(response.status === 429 ? 'rate_limited' : 'invalid'), RedirectType.replace)
  }

  redirect('/login?notice=password_reset', RedirectType.replace)
}

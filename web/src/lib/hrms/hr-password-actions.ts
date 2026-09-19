'use server'

import { hrExternalRedirect } from './hr-external-redirect'
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
 *
 * Every redirect here targets `/forgot-password`, `/reset-password` or
 * `/login` — all three exist as separate, real pages on the main marketing
 * site too, so every one of them goes through `hrExternalRedirect` rather
 * than Next's plain relative redirect. See that helper's own comment for why:
 * a relative redirect from a Server Action is resolved by the CLIENT router,
 * which has no idea `hrms.crowd4test.com` rewrites these paths, and lands on
 * the marketing site's own page of the same name instead.
 */

export async function hrForgotPasswordAction(formData: FormData): Promise<void> {
  const email = formTrimmed(formData, 'email')
  if (!email) hrExternalRedirect('/forgot-password?error=missing')

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
      hrExternalRedirect('/forgot-password?error=rate_limited')
    }
  } catch {
    hrExternalRedirect('/forgot-password?error=network')
  }

  hrExternalRedirect('/forgot-password?sent=1')
}

export async function hrResetPasswordAction(formData: FormData): Promise<void> {
  const token = formString(formData, 'token')
  const password = formString(formData, 'password')
  const confirmPassword = formString(formData, 'confirmPassword')
  // Carried through every bounce, or a mistyped confirmation would drop an
  // invitee back onto a page telling them to reset a password they never had.
  const invite = formString(formData, 'invite') === '1' ? '&invite=1' : ''
  const back = (error: string) =>
    `/reset-password?token=${encodeURIComponent(token)}&error=${error}${invite}`

  if (!token) hrExternalRedirect('/reset-password?error=missing_token')
  if (!password) hrExternalRedirect(back('missing'))
  if (password !== confirmPassword) hrExternalRedirect(back('mismatch'))

  let response: Response
  try {
    response = await fetch(new URL('/v1/hrms/auth/reset-password', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await currentAuthHeaders()) },
      body: JSON.stringify({ token, password }),
      cache: 'no-store',
    })
  } catch {
    hrExternalRedirect(back('network'))
  }

  if (!response.ok) {
    // 400 covers an expired, already-used or unknown link — all of which mean
    // "ask for a new one", so they share a message.
    hrExternalRedirect(back(response.status === 429 ? 'rate_limited' : 'invalid'))
  }

  hrExternalRedirect('/login?notice=password_reset')
}

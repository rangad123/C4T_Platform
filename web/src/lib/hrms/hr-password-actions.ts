'use server'

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
 * ── WHY THESE RETURN INSTEAD OF REDIRECTING
 *
 * `/forgot-password`, `/reset-password` and `/login` all exist a second time,
 * as real pages at the marketing site's top level. HRMS reaches its own
 * copies through a hostname rewrite that only the server knows about, so when
 * a Server Action redirected to one of those paths, Next's client router
 * resolved it against the filesystem and rendered the MARKETING page instead
 * — the same fault that made a wrong password show the marketing homepage.
 * An absolute URL does not help: Next normalises a same-origin one back into
 * a client transition.
 *
 * So these hand their result back to the form, which renders it in place. The
 * one genuine navigation left — to the sign-in page after a password is
 * successfully set — is done by the form with `window.location`, which is a
 * real browser request and therefore passes through the rewrite.
 */

export interface HrForgotPasswordState {
  error?: string
  sent?: boolean
}

export async function hrForgotPasswordAction(
  _previous: HrForgotPasswordState,
  formData: FormData,
): Promise<HrForgotPasswordState> {
  const email = formTrimmed(formData, 'email')
  if (!email) return { error: 'missing' }

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
    if (response.status === 429) return { error: 'rate_limited' }
  } catch {
    return { error: 'network' }
  }

  return { sent: true }
}

export interface HrResetPasswordState {
  error?: string
  /** Set once the password is saved; the form navigates to sign-in on it. */
  done?: boolean
}

export async function hrResetPasswordAction(
  _previous: HrResetPasswordState,
  formData: FormData,
): Promise<HrResetPasswordState> {
  const token = formString(formData, 'token')
  const password = formString(formData, 'password')
  const confirmPassword = formString(formData, 'confirmPassword')

  if (!token) return { error: 'missing_token' }
  if (!password) return { error: 'missing' }
  if (password !== confirmPassword) return { error: 'mismatch' }

  let response: Response
  try {
    response = await fetch(new URL('/v1/hrms/auth/reset-password', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await currentAuthHeaders()) },
      body: JSON.stringify({ token, password }),
      cache: 'no-store',
    })
  } catch {
    return { error: 'network' }
  }

  if (!response.ok) {
    // 400 covers an expired, already-used or unknown link — all of which mean
    // "ask for a new one", so they share a message.
    return { error: response.status === 429 ? 'rate_limited' : 'invalid' }
  }

  return { done: true }
}

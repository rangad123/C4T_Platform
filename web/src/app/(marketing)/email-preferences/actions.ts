'use server'

import { redirect, RedirectType } from 'next/navigation'
import { env } from '@/lib/env'
import { formTrimmed } from '@/lib/form-data'

/**
 * Turning notification email off and back on, from the link in an email
 * footer.
 *
 * ── NO SESSION, ON PURPOSE
 *
 * The reader is in their inbox, not in the app, and may not be signed in on
 * this device at all. The signed token from the email is the credential; the
 * API verifies it and it names exactly one user and one flag. That is why
 * this calls the API with a plain `fetch` instead of `actionFetch` — there is
 * no session to carry, and reaching for a helper that expects one would only
 * make it look like there is.
 *
 * The outcome goes back into the URL so the page renders from it. `replace`
 * rather than push: turning emails off and pressing Back should not offer the
 * reader an earlier version of a page whose button no longer describes the
 * state of anything.
 */
async function setPreference(token: string, enable: boolean): Promise<'on' | 'off' | 'invalid'> {
  if (!token) return 'invalid'

  const url = new URL(
    `/v1/notifications/unsubscribe?token=${encodeURIComponent(token)}&enable=${enable ? 'true' : 'false'}`,
    env.API_ORIGIN,
  )

  try {
    const response = await fetch(url, { method: 'POST', cache: 'no-store' })
    if (!response.ok) return 'invalid'
  } catch {
    // A network failure is not a rejected token, but from here the reader can
    // do exactly one thing about either — follow the link again — so they are
    // told the same thing.
    return 'invalid'
  }

  return enable ? 'on' : 'off'
}

export async function updateEmailPreferenceAction(formData: FormData): Promise<void> {
  const token = formTrimmed(formData, 'token')
  const enable = formData.get('enable') === 'true'

  const state = await setPreference(token, enable)

  const params = new URLSearchParams({ state })
  if (state !== 'invalid') params.set('token', token)
  redirect(`/email-preferences?${params.toString()}`, RedirectType.replace)
}

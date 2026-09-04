'use server'

import { revalidatePath } from 'next/cache'
import { redirect, RedirectType } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireUser } from '@/lib/auth/session'
import { safeNext } from '@/lib/safe-redirect'
import { formTrimmed } from '@/lib/form-data'

/**
 * The in-app half of the unsubscribe link.
 *
 * Testers, customers and admins all reach this from their own settings, so
 * the action lives here rather than in any one portal's `actions.ts` — three
 * copies of a one-field PATCH is how the three drift into disagreeing about
 * what the field is called.
 *
 * The API takes the user from the session, so there is no id to pass and no
 * way to aim this at somebody else's preference.
 */
export async function setEmailNotificationsAction(formData: FormData): Promise<void> {
  await requireUser()

  const enabled = formData.get('enabled') === 'true'
  /* Validated, not trusted: this lands in a redirect, and an unchecked value
     from a form field is an open redirect. `safeNext` rejects anything that
     is not a same-origin path. */
  const returnTo = safeNext(formTrimmed(formData, 'returnTo')) ?? '/'

  let failed = false
  try {
    await actionFetch('notifications/preferences', {
      method: 'PATCH',
      body: { emailNotifications: enabled },
    })
  } catch {
    failed = true
  }

  revalidatePath(returnTo)

  const separator = returnTo.includes('?') ? '&' : '?'
  const code = failed ? 'error=email_prefs_failed' : `ok=email_prefs_${enabled ? 'on' : 'off'}`
  redirect(`${returnTo}${separator}${code}`, RedirectType.replace)
}

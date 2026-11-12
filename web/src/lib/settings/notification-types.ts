'use server'

import { revalidatePath } from 'next/cache'
import { redirect, RedirectType } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireUser } from '@/lib/auth/session'
import { safeNext } from '@/lib/safe-redirect'
import { formTrimmed } from '@/lib/form-data'

/**
 * Saves the per-type choices from `NotificationTypesPanel`. The form posts
 * every type it showed under `type`, and a ticked box as `inApp:<TYPE>` /
 * `email:<TYPE>`: an unticked checkbox posts nothing, so the list of types is
 * what tells "off" apart from "not on the form". The API ignores essential
 * types, so a tampered form cannot turn those off either.
 */
export async function setNotificationTypesAction(formData: FormData): Promise<void> {
  await requireUser()

  const returnTo = safeNext(formTrimmed(formData, 'returnTo')) ?? '/'
  const types = formData
    .getAll('type')
    .filter((value): value is string => typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value))
    .slice(0, 50)

  let failed = false
  try {
    await actionFetch('notifications/preferences', {
      method: 'PATCH',
      body: {
        types: types.map((type) => ({
          type,
          inApp: formData.get(`inApp:${type}`) === 'on',
          email: formData.get(`email:${type}`) === 'on',
        })),
      },
    })
  } catch {
    failed = true
  }

  revalidatePath(returnTo)
  const separator = returnTo.includes('?') ? '&' : '?'
  const code = failed ? 'error=email_prefs_failed' : 'ok=notification_types_saved'
  redirect(`${returnTo}${separator}${code}`, RedirectType.replace)
}

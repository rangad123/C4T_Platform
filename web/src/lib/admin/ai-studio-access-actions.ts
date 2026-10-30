'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'
import { formStringArray, formTrimmed } from '@/lib/form-data'

/**
 * PUT users/:id/permissions with `scope: 'ai_studio'` — the AI Studio access
 * panel on the user, tester and manager pages.
 *
 * The scope makes the API replace only the `ai_studio.*` grants, so saving
 * this panel never touches a sub-admin's back-office permissions, and the
 * other editor never touches these.
 *
 * `subadmin.manage` is re-checked here: the panel being hidden is not a
 * boundary, since an action is a POST endpoint anyone with its id can call.
 * The API checks it again, along with which codes this account may hold.
 *
 * A refusal is shown in the API's own words (it writes 4xx messages for
 * people, such as "This feature cannot be given to a tester."); anything else
 * gets a generic notice.
 */

/** Only a page of the admin panel, so the hidden field cannot redirect anywhere else. */
function safeReturnPath(value: string): string {
  if (!value.startsWith('/app/admin/') || value.includes('//') || value.includes('\\')) {
    return '/app/admin/users'
  }
  return value
}

function withNotice(path: string, notice: string, reason?: string): string {
  const joiner = path.includes('?') ? '&' : '?'
  const extra = reason ? `&aiStudioReason=${encodeURIComponent(reason.slice(0, 200))}` : ''
  return `${path}${joiner}aiStudioNotice=${notice}${extra}`
}

export async function setAiStudioAccess(formData: FormData): Promise<void> {
  await requirePermission('subadmin.manage')

  const id = formTrimmed(formData, 'id')
  const returnTo = safeReturnPath(formTrimmed(formData, 'returnTo'))
  if (!id) redirect(returnTo)

  const permissionCodes = [
    ...new Set(
      formStringArray(formData, 'permissionCodes')
        .map((value) => value.trim())
        .filter((value) => value.startsWith('ai_studio.')),
    ),
  ]

  let target = withNotice(returnTo, 'saved')
  try {
    await actionFetch<unknown>(`users/${id}/permissions`, {
      method: 'PUT',
      body: { permissionCodes, scope: 'ai_studio' },
    })
    revalidatePath(returnTo.split('?')[0]!)
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      target = withNotice(returnTo, 'refused', error.message)
    } else {
      target = withNotice(returnTo, 'failed')
    }
  }

  redirect(target)
}

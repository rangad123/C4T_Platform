'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ApiError } from '@/lib/api/types'
/**
 * `actionFetch`, not `serverFetch`.
 *
 * The access cookie lives 15 minutes. `serverFetch` cannot refresh it — it
 * has no way to persist a rotated cookie — so a Server Action using it simply
 * fails once the reader has had the page open longer than that, with no
 * retry. `actionFetch` refreshes and retries once. Every other Server Action
 * in this app already uses it; these did not.
 */
import { actionFetch } from '@/lib/api/action-fetch'
import { getUser } from '@/lib/auth/session'
import { formString } from '@/lib/form-data'

/**
 * Assign a project to a manager, or remove such an assignment.
 *
 * The actions are thin: the API's `POST /v1/managers/assignments` is
 * upsert-style (re-calling with the same pair is a no-op), and the API's
 * `DELETE /v1/managers/assignments/:managerId/:projectId` is keyed by both
 * ids. The form's only inputs are the manager id (from the URL) and the
 * project id (from the row's assign button).
 */
/** Module-private: a `'use server'` file may only export async functions. */
function assignFailure(error: unknown): string {
  const code = error instanceof ApiError ? error.status : 0
  if (code === 403) return 'assign-forbidden'
  if (code === 404) return 'assign-missing'
  if (code === 409) return 'assign-duplicate'
  return 'assign-failed'
}

export async function assignProjectAction(formData: FormData): Promise<void> {
  await getUser()
  const managerId = formString(formData, 'managerId')
  const projectId = formString(formData, 'projectId')
  if (!managerId || !projectId) return

  let notice = 'assign-saved'
  try {
    await actionFetch('managers/assignments', {
      method: 'POST',
      body: { managerId, projectId },
    })
  } catch (error) {
    notice = assignFailure(error)
  }

  revalidatePath(`/app/admin/managers/${managerId}`)
  revalidatePath('/app/admin/managers')
  revalidatePath('/app/admin/projects')
  redirect(`/app/admin/managers/${managerId}?notice=${notice}`)
}

export async function unassignProjectAction(formData: FormData): Promise<void> {
  await getUser()
  const managerId = formString(formData, 'managerId')
  const projectId = formString(formData, 'projectId')
  if (!managerId || !projectId) return

  let notice = 'unassign-saved'
  try {
    await actionFetch(`managers/assignments/${managerId}/${projectId}`, {
      method: 'DELETE',
    })
  } catch (error) {
    notice = assignFailure(error)
  }

  revalidatePath(`/app/admin/managers/${managerId}`)
  revalidatePath('/app/admin/managers')
  redirect(`/app/admin/managers/${managerId}?notice=${notice}`)
}

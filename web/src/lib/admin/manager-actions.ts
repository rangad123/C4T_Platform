'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
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
export async function assignProjectAction(formData: FormData): Promise<void> {
  await getUser()
  const managerId = formString(formData, 'managerId')
  const projectId = formString(formData, 'projectId')
  if (!managerId || !projectId) return

  await serverFetch('managers/assignments', {
    method: 'POST',
    body: { managerId, projectId },
  })

  revalidatePath(`/app/admin/managers/${managerId}`)
  revalidatePath('/app/admin/managers')
  revalidatePath('/app/admin/projects')
}

export async function unassignProjectAction(formData: FormData): Promise<void> {
  await getUser()
  const managerId = formString(formData, 'managerId')
  const projectId = formString(formData, 'projectId')
  if (!managerId || !projectId) return

  await serverFetch(`managers/assignments/${managerId}/${projectId}`, {
    method: 'DELETE',
  })

  revalidatePath(`/app/admin/managers/${managerId}`)
  revalidatePath('/app/admin/managers')
}

'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { failureDetail } from '@/lib/testing/workflow'

/**
 * A tester applying to a build that is open to applications, or taking an
 * application back. The API owns every rule (verified tester, build open, not
 * already on it); a refusal comes back with its own sentence.
 *
 * Every export is an async function — see the note in the projects actions.
 */

const PATH = '/app/tester/apply'

function back(notice: string, detail?: string | null): string {
  const params = new URLSearchParams({ notice })
  if (detail) params.set('detail', detail)
  return `${PATH}?${params.toString()}`
}

export async function applyToBuild(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])
  const buildId = formTrimmed(formData, 'buildId')
  if (!buildId) redirect(PATH)
  const message = formTrimmed(formData, 'message')

  let target = back('applied')
  try {
    await actionFetch('applications', {
      method: 'POST',
      body: { buildId, ...(message ? { message } : {}) },
    })
    revalidatePath(PATH)
  } catch (error) {
    target = back('error', failureDetail(error))
  }
  redirect(target)
}

export async function withdrawApplication(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])
  const id = formTrimmed(formData, 'applicationId')
  if (!id) redirect(PATH)

  let target = back('withdrawn')
  try {
    await actionFetch(`applications/${id}/withdraw`, { method: 'POST' })
    revalidatePath(PATH)
  } catch (error) {
    target = back('error', failureDetail(error))
  }
  redirect(target)
}

'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { formTrimmed } from '@/lib/form-data'
import { failureDetail } from '@/lib/testing/workflow'

/**
 * Decisions on the testing review page: applications, executions, timesheets.
 * The API decides who may (admin, a sub-admin with the permission, or the
 * project's manager) and refuses a second decision; its sentence is shown.
 *
 * Every export is an async function — see the note in the projects actions.
 */

const PATH = '/app/admin/testing'

async function decide(section: string, path: string, body: Record<string, unknown>) {
  const params = new URLSearchParams({ section, notice: 'decided' })
  try {
    await actionFetch(path, { method: 'POST', body })
    revalidatePath(PATH)
  } catch (error) {
    params.set('notice', 'error')
    const detail = failureDetail(error)
    if (detail) params.set('detail', detail)
  }
  redirect(`${PATH}?${params.toString()}`)
}

export async function decideApplication(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const decision = formTrimmed(formData, 'decision')
  if (!id || !['ACCEPTED', 'DECLINED'].includes(decision)) redirect(PATH)
  const note = formTrimmed(formData, 'note')
  await decide('applications', `applications/${id}/decision`, {
    decision,
    ...(note ? { note } : {}),
  })
}

export async function reviewExecution(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const decision = formTrimmed(formData, 'decision')
  if (!id || !['APPROVED', 'REJECTED'].includes(decision)) redirect(PATH)
  const note = formTrimmed(formData, 'note')
  await decide('executions', `test-reports/${id}/review`, {
    decision,
    ...(note ? { note } : {}),
  })
}

export async function reviewTimesheet(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const decision = formTrimmed(formData, 'decision')
  if (!id || !['APPROVED', 'REJECTED'].includes(decision)) redirect(PATH)
  const note = formTrimmed(formData, 'note')
  const approved = formTrimmed(formData, 'approvedMinutes')
  await decide('timesheets', `timesheets/${id}/review`, {
    decision,
    ...(note ? { note } : {}),
    ...(decision === 'APPROVED' && approved ? { approvedMinutes: Number(approved) } : {}),
  })
}

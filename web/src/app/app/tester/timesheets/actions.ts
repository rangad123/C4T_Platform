'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { failureDetail } from '@/lib/testing/workflow'

const PATH = '/app/tester/timesheets'

/**
 * Log (or correct) the time spent on one build on one day. The API owns the
 * rules — on the build, not a future day, an approved day is final — and its
 * refusal is shown as written.
 */
export async function logTime(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])
  const buildId = formTrimmed(formData, 'buildId')
  const workDate = formTrimmed(formData, 'workDate')
  const hours = Number(formTrimmed(formData, 'hours') || '0')
  const mins = Number(formTrimmed(formData, 'minutes') || '0')
  const minutes = Math.round(hours * 60 + mins)
  const description = formTrimmed(formData, 'description')
  if (!buildId || !workDate || !Number.isFinite(minutes) || minutes < 1) {
    redirect(`${PATH}?notice=invalid`)
  }

  let target = `${PATH}?notice=logged`
  try {
    await actionFetch('timesheets', {
      method: 'POST',
      body: { buildId, workDate, minutes, ...(description ? { description } : {}) },
    })
    revalidatePath(PATH)
  } catch (error) {
    const detail = failureDetail(error)
    target = `${PATH}?notice=error${detail ? `&detail=${encodeURIComponent(detail)}` : ''}`
  }
  redirect(target)
}

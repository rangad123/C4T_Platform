'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const LIST_PATH = '/app/tester/test-cases'

const RESULTS: readonly string[] = ['PASS', 'FAIL', 'BLOCKED']

/**
 * Files the outcome of running a test case assigned to this tester. The API
 * (`testreport.create`) refuses this unless the case is actually assigned
 * to the caller — this action only narrows the enum, same division of
 * labour as `reportBugAction`.
 */
export async function submitTestReport(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const testCaseId = formTrimmed(formData, 'testCaseId')
  const resultInput = formTrimmed(formData, 'result')
  if (!testCaseId || !RESULTS.includes(resultInput)) {
    redirect(LIST_PATH)
  }

  const notes = formTrimmed(formData, 'notes')
  const devices = formTrimmed(formData, 'devices')
  const browsers = formTrimmed(formData, 'browsers')

  await serverFetch(`test-cases/${testCaseId}/reports`, {
    method: 'POST',
    body: {
      result: resultInput,
      ...(notes ? { notes } : {}),
      ...(devices ? { devices } : {}),
      ...(browsers ? { browsers } : {}),
    },
  })

  revalidatePath(LIST_PATH)
  redirect(`${LIST_PATH}?submitted=1`)
}

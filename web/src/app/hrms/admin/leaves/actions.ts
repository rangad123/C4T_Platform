'use server'

import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { hrExternalRedirect } from '@/lib/hrms/hr-external-redirect'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { ApiError } from '@/lib/api/types'
import { formString } from '@/lib/form-data'

const BASE = '/admin/leaves'

/**
 * Approve or reject one request from the all-employees list.
 *
 * On success it does NOT redirect: the row simply leaves the Pending list
 * when the page re-renders, which is the feedback, and the admin stays on
 * the tab, filter and page they were working through. Bouncing them back to
 * a bare URL after each of a dozen approvals would throw all three away.
 *
 * A refusal is different. Two admins can be looking at the same list, and
 * "this request has already been decided" is a real answer that has to reach
 * the screen rather than a crash — so that one, and only that one, redirects.
 */
export async function decideLeaveFromList(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const employeeId = formString(formData, 'employeeId')
  const requestId = formString(formData, 'requestId')
  const status = formString(formData, 'status')
  const section = formString(formData, 'section')

  try {
    await hrActionFetch(`hrms/employees/${employeeId}/leaves/requests/${requestId}/decide`, {
      method: 'POST',
      body: { status },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      const back = section && section !== 'pending' ? `${BASE}?section=${section}&` : `${BASE}?`
      hrExternalRedirect(`${back}notice=refused&reason=${encodeURIComponent(error.message)}`)
    }
    throw error
  }
  revalidateHrms(BASE)
}

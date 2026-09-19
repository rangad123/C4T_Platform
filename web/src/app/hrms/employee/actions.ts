'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formString, formTrimmed } from '@/lib/form-data'

const ANY_EMPLOYEE = ['ADMIN', 'ACCOUNT_MANAGER', 'EMPLOYEE'] as const

function leavesPath(financialYear: string): string {
  return `/employee/leaves?fy=${financialYear}`
}

export async function applyForLeave(formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  const financialYear = formString(formData, 'financialYear')
  try {
    await hrActionFetch('hrms/leaves/requests', {
      method: 'POST',
      body: {
        leaveTypeId: formString(formData, 'leaveTypeId'),
        startDate: formString(formData, 'startDate'),
        endDate: formString(formData, 'endDate'),
        reason: formTrimmed(formData, 'reason') || undefined,
      },
    })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
      redirect(`${leavesPath(financialYear)}&error=${encodeURIComponent(error.message)}`)
    }
    throw error
  }
  revalidateHrms('/employee/leaves')
  redirect(leavesPath(financialYear))
}

export async function cancelLeaveRequest(id: string, formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  await hrActionFetch(`hrms/leaves/requests/${id}/cancel`, { method: 'POST' })
  revalidateHrms('/employee/leaves')
  redirect(leavesPath(formString(formData, 'financialYear')))
}

function timesheetPath(financialYear: string, month: string): string {
  return `/employee/timesheet?fy=${financialYear}&month=${month}`
}

export async function saveTimesheetEntry(formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  const financialYear = formString(formData, 'financialYear')
  const month = formString(formData, 'month')
  await hrActionFetch('hrms/timesheet/entries', {
    method: 'PUT',
    body: {
      date: formString(formData, 'date'),
      description: formTrimmed(formData, 'description') || undefined,
      hours: formString(formData, 'hours') || '0',
      extraHours: formString(formData, 'extraHours') || '0',
    },
  })
  revalidateHrms('/employee/timesheet')
  redirect(timesheetPath(financialYear, month))
}

export async function deleteTimesheetEntry(id: string, formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  await hrActionFetch(`hrms/timesheet/entries/${id}`, { method: 'DELETE' })
  revalidateHrms('/employee/timesheet')
  redirect(timesheetPath(formString(formData, 'financialYear'), formString(formData, 'month')))
}

'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formString, formTrimmed } from '@/lib/form-data'
import { combinePhoneFromForm } from '@/lib/phone/combine'

const ANY_EMPLOYEE = ['ADMIN', 'ACCOUNT_MANAGER', 'EMPLOYEE'] as const

const BASIC_DETAILS = '/employee'

/**
 * The employee filling in their own personal details — the step after they
 * accept their invitation. Blank fields are left out of the body rather than
 * sent empty, so saving a half-filled form never wipes what is already there.
 */
export async function updateMyPersonalDetails(formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  try {
    await hrActionFetch('hrms/me/profile', {
      method: 'PATCH',
      body: {
        dateOfBirth: formString(formData, 'dateOfBirth') || undefined,
        gender: formString(formData, 'gender') || undefined,
        phone: combinePhoneFromForm(formData) || undefined,
        address: formTrimmed(formData, 'address') || undefined,
      },
    })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
      redirect(`${BASIC_DETAILS}?edit=personal&error=rejected`)
    }
    throw error
  }
  revalidateHrms(BASIC_DETAILS)
  redirect(`${BASIC_DETAILS}?notice=saved`)
}

/**
 * The employee setting their own photo. `SingleFileUpload` already stored the
 * bytes and returned a file id — this just attaches it, no password needed
 * (see the schema's own note on why not).
 */
export async function updateMyProfilePicture(formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  const fileId = formData.get('fileId')
  if (typeof fileId !== 'string' || !fileId) return
  await hrActionFetch('hrms/me/profile', {
    method: 'PATCH',
    body: { profilePictureFileId: fileId },
  })
  revalidateHrms(BASIC_DETAILS)
}

/**
 * PAN and bank details. The employee's own password goes with them: changing
 * where pay is sent is the change a stolen session would try first, so it must
 * not be possible without knowing it. A wrong password comes back as a 401.
 */
export async function updateMyFinancialDetails(formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  try {
    await hrActionFetch('hrms/me/profile', {
      method: 'PATCH',
      body: {
        currentPassword: formString(formData, 'currentPassword'),
        panNumber: formTrimmed(formData, 'panNumber') || undefined,
        bankName: formTrimmed(formData, 'bankName') || undefined,
        branchName: formTrimmed(formData, 'branchName') || undefined,
        accountName: formTrimmed(formData, 'accountName') || undefined,
        accountNumber: formTrimmed(formData, 'accountNumber') || undefined,
        ifscCode: formTrimmed(formData, 'ifscCode') || undefined,
      },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect(`${BASIC_DETAILS}?edit=financial&error=incorrect`)
    }
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
      redirect(`${BASIC_DETAILS}?edit=financial&error=rejected`)
    }
    throw error
  }
  revalidateHrms(BASIC_DETAILS)
  redirect(`${BASIC_DETAILS}?notice=saved`)
}

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
  try {
    await hrActionFetch('hrms/timesheet/entries', {
      method: 'PUT',
      body: {
        date: formString(formData, 'date'),
        description: formTrimmed(formData, 'description') || undefined,
        hours: formString(formData, 'hours') || '0',
        extraHours: formString(formData, 'extraHours') || '0',
      },
    })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
      redirect(`${timesheetPath(financialYear, month)}&error=${encodeURIComponent(error.message)}`)
    }
    throw error
  }
  revalidateHrms('/employee/timesheet')
  redirect(timesheetPath(financialYear, month))
}

export async function deleteTimesheetEntry(id: string, formData: FormData): Promise<void> {
  await requireHrRole([...ANY_EMPLOYEE])
  await hrActionFetch(`hrms/timesheet/entries/${id}`, { method: 'DELETE' })
  revalidateHrms('/employee/timesheet')
  redirect(timesheetPath(formString(formData, 'financialYear'), formString(formData, 'month')))
}

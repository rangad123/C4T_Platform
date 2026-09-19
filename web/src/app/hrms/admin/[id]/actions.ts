'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formTrimmed, formString } from '@/lib/form-data'

const BASE = '/admin'

function detailPath(id: string): string {
  return `${BASE}/${id}`
}

async function patchEmployee(id: string, body: Record<string, unknown>): Promise<void> {
  try {
    await hrActionFetch(`hrms/employees/${id}`, { method: 'PATCH', body })
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      redirect(`${detailPath(id)}?error=rejected`)
    }
    throw error
  }
}

export async function updatePersonalDetails(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  await patchEmployee(id, {
    email: formTrimmed(formData, 'email'),
    firstName: formTrimmed(formData, 'firstName'),
    lastName: formTrimmed(formData, 'lastName'),
    dateOfBirth: formString(formData, 'dateOfBirth') || undefined,
    gender: formString(formData, 'gender') || undefined,
    phone: formTrimmed(formData, 'phone') || undefined,
    address: formTrimmed(formData, 'address') || undefined,
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(detailPath(id))
}

export async function updateEmploymentDetails(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  await patchEmployee(id, {
    designationId: formString(formData, 'designationId') || undefined,
    role: formString(formData, 'role') || undefined,
    accountType: formString(formData, 'accountType') || undefined,
    reportsToId: formString(formData, 'reportsToId') || undefined,
    joiningDate: formString(formData, 'joiningDate') || undefined,
    timesheetRequired: formData.get('timesheetRequired') != null,
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(detailPath(id))
}

/**
 * Financial fields left blank are OMITTED from the body, not sent as empty
 * strings — the API merges a partial update against whatever is already
 * encrypted on the row (see hr-employees.service.ts's `updateEmployee`), so
 * "blank" here means "leave this one alone", not "clear it". Sending `''`
 * would also fail the PAN/IFSC regex and 422 for no reason.
 */
export async function updateFinancialDetails(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  await patchEmployee(id, {
    taxRegime: formString(formData, 'taxRegime') || undefined,
    panNumber: formTrimmed(formData, 'panNumber') || undefined,
    accountNumber: formTrimmed(formData, 'accountNumber') || undefined,
    accountName: formTrimmed(formData, 'accountName') || undefined,
    ifscCode: formTrimmed(formData, 'ifscCode') || undefined,
    bankName: formTrimmed(formData, 'bankName') || undefined,
    branchName: formTrimmed(formData, 'branchName') || undefined,
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(detailPath(id))
}

export async function changeEmployeeStatus(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/employees/${id}/status`, {
    method: 'POST',
    body: {
      status: formString(formData, 'status'),
      relievingDate: formString(formData, 'relievingDate') || undefined,
    },
  })
  revalidateHrms(`${BASE}/${id}`)
  revalidateHrms(BASE)
  redirect(detailPath(id))
}

export async function attachProfilePicture(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const fileId = formData.get('fileId')
  if (typeof fileId !== 'string' || !fileId) return
  await hrActionFetch(`hrms/employees/${id}`, {
    method: 'PATCH',
    body: { profilePictureFileId: fileId },
  })
  revalidateHrms(`${BASE}/${id}`)
  revalidateHrms(BASE)
}

/**
 * Emails the employee a link to choose their own password — the first one, or
 * a replacement for an invitation that lapsed before they opened it.
 *
 * Safe to run more than once: each send invalidates the previous link, so a
 * second click does not leave two working invitations in an inbox.
 */
export async function sendEmployeeInvitation(id: string): Promise<void> {
  await requireHrRole(['ADMIN'])
  try {
    await hrActionFetch(`hrms/employees/${id}/invite`, { method: 'POST' })
  } catch (error) {
    // The API refuses to invite anyone who has left. That is an answer worth
    // reading, not a crash.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      redirect(`${detailPath(id)}?notice=invite_refused&reason=${encodeURIComponent(error.message)}`)
    }
    throw error
  }
  redirect(`${detailPath(id)}?notice=invited`)
}

// ─── Salary details ──────────────────────────────────────────────────────────

function sectionPath(id: string, section: string, financialYear: string): string {
  return `${BASE}/${id}?section=${section}&fy=${financialYear}`
}

export async function updateSalaryStructure(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  await patchSalary(id, {
    method: 'PUT',
    path: `hrms/employees/${id}/salary-structure`,
    body: {
      financialYear,
      basic: formString(formData, 'basic') || '0',
      hra: formString(formData, 'hra') || '0',
      specialAllowance: formString(formData, 'specialAllowance') || '0',
    },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'salary', financialYear))
}

async function patchSalary(
  id: string,
  request: { method: 'PUT' | 'POST' | 'DELETE'; path: string; body?: Record<string, unknown> },
): Promise<void> {
  try {
    await hrActionFetch(request.path, { method: request.method, body: request.body })
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      redirect(`${detailPath(id)}?error=rejected`)
    }
    throw error
  }
}

export async function addOldSalary(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  await patchSalary(id, {
    method: 'POST',
    path: `hrms/employees/${id}/old-salaries`,
    body: {
      ctc: formString(formData, 'ctc') || '0',
      fromDate: formString(formData, 'fromDate'),
      toDate: formString(formData, 'toDate'),
    },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'salary', formString(formData, 'financialYear')))
}

export async function deleteOldSalary(
  id: string,
  oldSalaryId: string,
  financialYear: string,
): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/employees/${id}/old-salaries/${oldSalaryId}`, { method: 'DELETE' })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'salary', financialYear))
}

export async function addMonthlyIncentive(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  await patchSalary(id, {
    method: 'POST',
    path: `hrms/employees/${id}/monthly-incentives`,
    body: {
      financialYear,
      month: formString(formData, 'month'),
      incentiveTypeId: formString(formData, 'incentiveTypeId'),
      amount: formString(formData, 'amount') || '0',
    },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'salary', financialYear))
}

export async function deleteMonthlyIncentive(
  id: string,
  incentiveId: string,
  financialYear: string,
): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/employees/${id}/monthly-incentives/${incentiveId}`, {
    method: 'DELETE',
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'salary', financialYear))
}

// ─── Leaves (admin decides; the employee's own apply/cancel live in the
// Employee Portal's own actions.ts) ────────────────────────────────────────

export async function decideLeaveRequest(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  const requestId = formString(formData, 'requestId')
  await patchSalary(id, {
    method: 'POST',
    path: `hrms/employees/${id}/leaves/requests/${requestId}/decide`,
    body: { status: formString(formData, 'status') },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'leaves', financialYear))
}

// ─── Payslip ─────────────────────────────────────────────────────────────────

export async function generatePayslip(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  await patchSalary(id, {
    method: 'POST',
    path: `hrms/employees/${id}/payslips`,
    body: { financialYear, month: formString(formData, 'month') },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'payslip', financialYear))
}

// ─── Investments ─────────────────────────────────────────────────────────────

export async function addInvestmentDeclaration(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  await patchSalary(id, {
    method: 'POST',
    path: `hrms/employees/${id}/investment-declarations`,
    body: {
      financialYear,
      sectionId: formString(formData, 'sectionId'),
      description: formTrimmed(formData, 'description') || undefined,
      declaredAmount: formString(formData, 'declaredAmount') || '0',
    },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'investments', financialYear))
}

export async function verifyInvestmentDeclaration(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  const declarationId = formString(formData, 'declarationId')
  await patchSalary(id, {
    method: 'POST',
    path: `hrms/employees/${id}/investment-declarations/${declarationId}/verify`,
    body: { verifiedAmount: formString(formData, 'verifiedAmount') || '0' },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'investments', financialYear))
}

export async function deleteInvestmentDeclaration(
  id: string,
  declarationId: string,
  financialYear: string,
): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/employees/${id}/investment-declarations/${declarationId}`, {
    method: 'DELETE',
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'investments', financialYear))
}

export async function addMonthlyDeduction(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  await patchSalary(id, {
    method: 'POST',
    path: `hrms/employees/${id}/monthly-tax-deductions`,
    body: {
      financialYear,
      month: formString(formData, 'month'),
      amount: formString(formData, 'amount') || '0',
    },
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'investments', financialYear))
}

export async function deleteMonthlyDeduction(
  id: string,
  deductionId: string,
  financialYear: string,
): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/employees/${id}/monthly-tax-deductions/${deductionId}`, {
    method: 'DELETE',
  })
  revalidateHrms(`${BASE}/${id}`)
  redirect(sectionPath(id, 'investments', financialYear))
}

export interface RevealedFinancialDetails {
  panNumber?: string
  accountNumber?: string
  accountName?: string
  ifscCode?: string
}

export type RevealFinancialDetailsResult =
  { ok: true; details: RevealedFinancialDetails } | { ok: false; message: string }

/**
 * Step-up reveal of PAN/bank details — mirrors the platform's
 * `revealPaymentAccountAction` (see `app/app/admin/testers/[id]/actions.ts`):
 * the caller's OWN password gates it, and the decrypted value is returned
 * once to client state, never persisted or logged.
 */
export async function revealFinancialDetailsAction(
  employeeId: string,
  password: string,
): Promise<RevealFinancialDetailsResult> {
  await requireHrRole(['ADMIN'])
  try {
    const details = await hrActionFetch<RevealedFinancialDetails>(
      `hrms/employees/${employeeId}/financial-details/reveal`,
      { method: 'POST', body: { password } },
    )
    return { ok: true, details }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      return { ok: false, message: 'Incorrect password.' }
    return { ok: false, message: 'Could not reveal these details. Try again.' }
  }
}

// ─── Documents ───────────────────────────────────────────────────────────────

function documentsPath(id: string, message?: string): string {
  const base = `${BASE}/${id}?section=documents`
  return message ? `${base}&docError=${encodeURIComponent(message)}` : base
}

/**
 * Attaches an already-uploaded file to the employee as a document.
 *
 * `kind` is bound by the page rather than carried in the FormData because
 * `SingleFileUpload` decides what that FormData contains — it sends the one
 * `fileId` it got back and nothing else. Binding is how the caller adds
 * context without every upload site having to fork the component.
 *
 * The 400 the API returns at the ten-document cap is a real answer, not a
 * fault, so it is carried back to the page as text instead of thrown.
 */
export async function addEmployeeDocument(
  id: string,
  kind: string,
  formData: FormData,
): Promise<void> {
  await requireHrRole(['ADMIN'])
  const fileId = formData.get('fileId')
  if (typeof fileId !== 'string' || !fileId) return
  try {
    await hrActionFetch(`hrms/employees/${id}/documents`, {
      method: 'POST',
      body: { kind, fileId },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      redirect(documentsPath(id, error.message))
    }
    throw error
  }
  revalidateHrms(`${BASE}/${id}`)
}

export async function removeEmployeeDocument(id: string, documentId: string): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/employees/${id}/documents/${documentId}`, { method: 'DELETE' })
  revalidateHrms(`${BASE}/${id}`)
  redirect(documentsPath(id))
}

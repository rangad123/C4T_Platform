'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formTrimmed, formString } from '@/lib/form-data'
import type { TemporaryPasswordState } from './temporary-password-state'

const BASE = '/admin'

function detailPath(id: string): string {
  return `${BASE}/${id}`
}

async function patchEmployee(id: string, body: Record<string, unknown>): Promise<void> {
  try {
    await hrActionFetch(`hrms/employees/${id}`, { method: 'PATCH', body })
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.status === 422) redirect(`${detailPath(id)}?error=rejected`)
    // Any other 4xx is the API declining for a stated reason — "the relieving
    // date cannot be before the joining date", "an employee with this email
    // already exists" — and that sentence is the whole answer. It used to
    // escape as an unhandled error and replace the page with a crash screen.
    if (error.status >= 400 && error.status < 500) {
      redirect(`${detailPath(id)}?notice=refused&reason=${encodeURIComponent(error.message)}`)
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
    // `null`, not `undefined`, when blank: an empty field means "clear it".
    relievingDate: formString(formData, 'relievingDate') || null,
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

/**
 * Sets a temporary password and hands it back to the form that asked, which
 * shows it once. It is returned, not redirected with: a redirect would put it in
 * a URL, and a URL ends up in browser history and server logs.
 *
 * A refusal ("only an active employee can sign in") comes back as a message on
 * the form rather than an error page.
 */
export async function setTemporaryPassword(
  _previous: TemporaryPasswordState,
  formData: FormData,
): Promise<TemporaryPasswordState> {
  await requireHrRole(['ADMIN'])
  const id = formString(formData, 'employeeId')
  const typed = formString(formData, 'password')

  try {
    const result = await hrActionFetch<{ password: string }>(
      `hrms/employees/${id}/temporary-password`,
      { method: 'POST', body: typed ? { password: typed } : {} },
    )
    return { status: 'done', password: result.password }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.status === 422) {
      return { status: 'error', message: 'A password needs at least 12 characters.' }
    }
    if (error.status >= 400 && error.status < 500) {
      return { status: 'error', message: error.message }
    }
    throw error
  }
}

export async function changeEmployeeStatus(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  try {
    await hrActionFetch(`hrms/employees/${id}/status`, {
      method: 'POST',
      body: {
        status: formString(formData, 'status'),
        relievingDate: formString(formData, 'relievingDate') || undefined,
      },
    })
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    // Refused for a stated reason, most often "this is the only active HR
    // administrator". That sentence is the whole answer, not a crash.
    if (error.status >= 400 && error.status < 500) {
      redirect(`${detailPath(id)}?notice=refused&reason=${encodeURIComponent(error.message)}`)
    }
    throw error
  }
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

/**
 * Shared write path for the salary, investment and payslip tabs.
 *
 * A 422 is a field-level rejection and gets the generic "check the values"
 * banner — the form is right there. Any other 4xx is the API declining for a
 * stated reason ("no salary breakdown is recorded for 2021-2022"), and that
 * sentence is the whole answer, so it is carried back and shown. Without
 * this it escaped as an unhandled error and the admin got a crash screen
 * instead of the one line telling them what to do.
 *
 * `back` lets a caller return to the tab the action was fired from; without
 * it the reader lands on Basic details and has to find their way back.
 */
async function patchSalary<T = void>(
  id: string,
  request: {
    method: 'PUT' | 'POST' | 'DELETE'
    path: string
    body?: Record<string, unknown>
    back?: string
  },
): Promise<T> {
  try {
    return await hrActionFetch<T>(request.path, { method: request.method, body: request.body })
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.status === 422) redirect(`${detailPath(id)}?error=rejected`)
    if (error.status >= 400 && error.status < 500) {
      const back = request.back ?? detailPath(id)
      const joiner = back.includes('?') ? '&' : '?'
      redirect(`${back}${joiner}notice=refused&reason=${encodeURIComponent(error.message)}`)
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
    back: sectionPath(id, 'payslip', financialYear),
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

/**
 * Fills in TDS for every month up to the one chosen that has no entry yet.
 *
 * The API never changes a month that already has a figure, so pressing this
 * twice — or after typing one month by hand — is safe. To recalculate a
 * month, remove its entry first.
 */
export async function calculateMonthlyDeductions(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const financialYear = formString(formData, 'financialYear')
  const back = sectionPath(id, 'investments', financialYear)
  const result = await patchSalary<{ created: unknown[]; skipped: string | null }>(id, {
    method: 'POST',
    path: `hrms/employees/${id}/monthly-tax-deductions/calculate`,
    body: { financialYear, month: formString(formData, 'month') },
    back,
  })
  revalidateHrms(`${BASE}/${id}`)
  if (result.skipped) {
    redirect(`${back}&notice=refused&reason=${encodeURIComponent(result.skipped)}`)
  }
  redirect(`${back}&notice=${result.created.length > 0 ? 'tds_calculated' : 'tds_nothing'}`)
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

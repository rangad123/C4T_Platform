'use server'

import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { isValidFinancialYear } from '@/lib/hrms/financial-year'
import { ApiError } from '@/lib/api/types'

export type GenerateOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Generates one employee's payslip for a month and reports what happened.
 *
 * This is called by the payslip run one employee at a time, from the browser,
 * rather than looping over everyone here. Each PDF is drawn by a headless
 * Chrome and takes 10–20 seconds, so a single request for a whole company
 * would outlast the proxy in front of the API. One call per person keeps every
 * request short, lets the page show real progress, and means a run that is
 * interrupted loses nothing — the next run skips whoever is already done.
 *
 * It returns an outcome instead of throwing. A refusal ("no salary breakdown
 * is recorded") is an ordinary result the runner must show against that
 * person and carry on past; a thrown error would end the run at the first
 * one, and in production its message would be stripped before it arrived.
 */
export async function generatePayslipForEmployee(
  employeeId: string,
  financialYear: string,
  month: number,
): Promise<GenerateOutcome> {
  await requireHrRole(['ADMIN'])

  if (
    typeof employeeId !== 'string' ||
    employeeId === '' ||
    !isValidFinancialYear(financialYear) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return { ok: false, reason: 'That pay period is not valid.' }
  }

  try {
    await hrActionFetch(`hrms/employees/${employeeId}/payslips`, {
      method: 'POST',
      body: { financialYear, month },
    })
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      return { ok: false, reason: error.message }
    }
    return {
      ok: false,
      reason: 'The payslip could not be produced. Try this one again from the employee record.',
    }
  }
}

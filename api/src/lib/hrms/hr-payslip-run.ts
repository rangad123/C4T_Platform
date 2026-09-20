/**
 * Where one employee stands for a month's payslip run.
 *
 *   generated            a payslip already exists for the month
 *   not-employed         they had not joined yet, or had already left
 *   no-salary-breakdown  no basic/HRA/special allowance on record, which
 *                        payslip generation refuses to render
 *   ready                a run would generate it
 *
 * The order is the rule. An existing payslip wins over everything else, so a
 * run never offers to regenerate something it cannot explain; "not employed"
 * comes before "no breakdown" because someone who was not there that month
 * needs no salary record for it, and telling an admin to add one would be
 * asking for something that does not apply.
 */
export type PayslipRunState = 'ready' | 'generated' | 'no-salary-breakdown' | 'not-employed'

export function payslipRunState(input: {
  hasPayslip: boolean
  employed: boolean
  hasBreakdown: boolean
}): PayslipRunState {
  if (input.hasPayslip) return 'generated'
  if (!input.employed) return 'not-employed'
  if (!input.hasBreakdown) return 'no-salary-breakdown'
  return 'ready'
}

/**
 * Professional tax on a payslip.
 *
 * ── THE RULE
 *
 * It is charged only on a monthly gross ABOVE Rs. 25,000, at Rs. 200 for the
 * month. Someone at or under the threshold pays nothing. It used to be taken
 * from everyone on the payroll whenever a rate existed for the year, which
 * over-deducted from lower earners and, with no rate row set up, deducted from
 * nobody at all.
 *
 * "Monthly gross" is that month's gross earnings as the payslip prints them:
 * salary components plus any incentive paid in the month.
 *
 * The rate for a year can still be set (in the table it lives in) and then wins
 * over the default, including a rate of 0 meaning "none this year". Only the
 * threshold is fixed here.
 */
export const PROFESSIONAL_TAX_THRESHOLD_MONTHLY = 25000
export const DEFAULT_PROFESSIONAL_TAX_MONTHLY = 200

export function professionalTaxFor(input: {
  grossMonthly: number
  /** The year's configured amount, or null when none is set up. */
  configuredMonthly: number | null
}): number {
  if (!(input.grossMonthly > PROFESSIONAL_TAX_THRESHOLD_MONTHLY)) return 0
  return input.configuredMonthly ?? DEFAULT_PROFESSIONAL_TAX_MONTHLY
}

/**
 * What a stored payslip actually deducted for professional tax.
 *
 * A report adds up what was taken, read off the payslips, rather than
 * multiplying a headcount by a rate: only some people pay it, and not
 * necessarily in every month.
 */
export function professionalTaxDeducted(snapshot: unknown): number {
  if (typeof snapshot !== 'object' || snapshot === null) return 0
  const deductions = (snapshot as { deductions?: unknown }).deductions
  if (typeof deductions !== 'object' || deductions === null) return 0
  const value = (deductions as { professionalTaxMonthly?: unknown }).professionalTaxMonthly
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

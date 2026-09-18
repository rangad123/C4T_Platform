/**
 * Pure Indian income-tax computation — no I/O, no Prisma, unit-testable on
 * its own. Every rate, slab boundary, cess percentage and rebate threshold
 * is a PARAMETER read by the caller from `HrTaxSlab` (admin-editable,
 * versioned by financial year + regime); nothing here is a hardcoded
 * constant of a given year's Budget, per the brief's own requirement that
 * "tax calculations must be implemented as actual business logic, not
 * hardcoded values."
 *
 * Rounding is deliberately NOT done at each intermediate step (the way a
 * strict reading of Sections 288A/288B would) — that would compound
 * rounding error differently depending on computation order. This returns
 * exact figures; the one place that needs whole rupees (a payslip or a
 * screen) rounds for display only.
 */

export interface TaxSlabBand {
  /** Upper bound of this band's taxable income, or `null` for "and above". */
  upTo: number | null
  /** Percentage rate applied to the portion of income inside this band. */
  rate: number
}

export interface TaxSlabConfig {
  slabs: readonly TaxSlabBand[]
  standardDeduction: number
  cessRatePercent: number
  /** Total taxable income at or below this qualifies for the §87A rebate. */
  rebate87ALimit: number
  /** The rebate never exceeds this amount, even if slab tax is higher. */
  rebate87AMaxAmount: number
}

export interface TaxComputationInput {
  /** Fixed + variable annual pay actually earned this FY. */
  grossSalaryAnnual: number
  /** Sum of verified (falling back to declared) Chapter VI-A investments. Ignored under the new regime. */
  chapterVIADeductions: number
  regime: 'OLD' | 'NEW'
  slabConfig: TaxSlabConfig
  /** TDS already deducted and deposited so far this FY. */
  tdsDeductedTillDate: number
}

export interface TaxComputationResult {
  grossSalary: number
  standardDeduction: number
  incomeFromSalary: number
  chapterVIADeductions: number
  totalTaxableIncome: number
  taxOnTotalIncome: number
  rebate87A: number
  taxAfterRebate: number
  cess: number
  totalTaxLiability: number
  tdsDeductedTillDate: number
  /** Positive = still owed; negative = refund due. */
  taxPayableOrRefundable: number
}

/** Slab-wise tax on a taxable income, given an ordered, non-overlapping set of bands. */
export function computeSlabTax(taxableIncome: number, slabs: readonly TaxSlabBand[]): number {
  let tax = 0
  let lowerBound = 0
  for (const band of slabs) {
    if (taxableIncome <= lowerBound) break
    const upperBound = band.upTo ?? Number.POSITIVE_INFINITY
    const taxableInBand = Math.min(taxableIncome, upperBound) - lowerBound
    if (taxableInBand > 0) tax += taxableInBand * (band.rate / 100)
    lowerBound = upperBound
  }
  return tax
}

export function computeTax(input: TaxComputationInput): TaxComputationResult {
  const { grossSalaryAnnual, regime, slabConfig, tdsDeductedTillDate } = input

  const grossSalary = Math.max(0, grossSalaryAnnual)
  const standardDeduction = Math.min(Math.max(0, slabConfig.standardDeduction), grossSalary)
  const incomeFromSalary = grossSalary - standardDeduction

  // Chapter VI-A (80C, 80D, …) deductions do not exist under the new
  // regime — enforced here too, not just by whatever the caller passes, so
  // a stale/incorrect caller can never inflate a new-regime refund.
  const chapterVIADeductions = regime === 'OLD' ? Math.max(0, input.chapterVIADeductions) : 0

  const totalTaxableIncome = Math.max(0, incomeFromSalary - chapterVIADeductions)
  const taxOnTotalIncome = computeSlabTax(totalTaxableIncome, slabConfig.slabs)

  const rebate87A =
    totalTaxableIncome <= slabConfig.rebate87ALimit
      ? Math.min(taxOnTotalIncome, Math.max(0, slabConfig.rebate87AMaxAmount))
      : 0
  const taxAfterRebate = Math.max(0, taxOnTotalIncome - rebate87A)

  const cess = taxAfterRebate * (slabConfig.cessRatePercent / 100)
  const totalTaxLiability = taxAfterRebate + cess

  const taxPayableOrRefundable = totalTaxLiability - tdsDeductedTillDate

  return {
    grossSalary,
    standardDeduction,
    incomeFromSalary,
    chapterVIADeductions,
    totalTaxableIncome,
    taxOnTotalIncome,
    rebate87A,
    taxAfterRebate,
    cess,
    totalTaxLiability,
    tdsDeductedTillDate,
    taxPayableOrRefundable,
  }
}

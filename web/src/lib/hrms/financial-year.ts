/**
 * Frontend counterpart to the API's `lib/hrms/financial-year.ts` — just
 * enough to build a financial-year picker. The API remains the source of
 * truth for validating and computing against an FY string; this never does
 * the arithmetic that feeds a calculation, only the arithmetic that builds a
 * `<select>`.
 */

const FY_PATTERN = /^(\d{4})-(\d{4})$/

/** Narrows an untrusted `?fy=` query value before it reaches an API call. */
export function isValidFinancialYear(value: string): boolean {
  const match = FY_PATTERN.exec(value)
  if (!match) return false
  return Number(match[2]) === Number(match[1]) + 1
}

/** The FY a given date falls in, as "2026-2027" — April onward belongs to that calendar year's FY. */
export function financialYearOf(date: Date): string {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const startYear = month >= 4 ? year : year - 1
  return `${startYear}-${startYear + 1}`
}

export function currentFinancialYear(): string {
  return financialYearOf(new Date())
}

/**
 * Financial years to offer in a picker, newest first.
 *
 * `ahead` matters: this counted only backwards from the current year, so every
 * dropdown in HRMS stopped at the year in progress. Salary structures, tax
 * slabs and declarations are all routinely set up BEFORE the year they apply
 * to, and on 1 April the newly-current year would not have been selectable at
 * all until someone shipped a fix.
 */
export function recentFinancialYears(back = 5, ahead = 5): string[] {
  const [currentStart] = currentFinancialYear().split('-').map(Number)
  const start = currentStart ?? 0
  return Array.from({ length: back + ahead }, (_, i) => {
    const year = start + ahead - i
    return `${year}-${year + 1}`
  })
}

export interface FinancialYearMonth {
  month: number
  calendarYear: number
  label: string
}

/** The 12 (month, calendarYear, label) triples for an FY, in April-to-March order. */
export function financialYearMonths(financialYear: string): FinancialYearMonth[] {
  const [startYear, endYear] = financialYear.split('-').map(Number) as [number, number]
  const order = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]
  return order.map((month) => {
    const calendarYear = month >= 4 ? startYear : endYear
    const label = new Date(calendarYear, month - 1, 1).toLocaleString('en-US', { month: 'short' })
    return { month, calendarYear, label: `${label} ${calendarYear}` }
  })
}

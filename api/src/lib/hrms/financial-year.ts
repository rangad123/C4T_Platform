import { BadRequestError } from '../errors.js'

/**
 * Indian financial-year math — April 1 to March 31, stored everywhere in
 * HRMS as the string `"2026-2027"` (see the `financialYear` fields across
 * `Hr*` models). `month` on those same models is a literal CALENDAR month
 * (1 = January … 12 = December), not an FY-relative index — April is month
 * 4, and January/February/March of the FY's second calendar year are months
 * 1/2/3. This file is the one place that mapping is done, so it is never
 * reimplemented slightly differently in two services.
 */

const FY_PATTERN = /^(\d{4})-(\d{4})$/

export interface FinancialYearRange {
  startYear: number
  endYear: number
}

export function parseFinancialYear(financialYear: string): FinancialYearRange {
  const match = FY_PATTERN.exec(financialYear)
  if (!match) {
    throw new BadRequestError(`"${financialYear}" is not a valid financial year, e.g. "2026-2027"`)
  }
  const startYear = Number(match[1])
  const endYear = Number(match[2])
  if (endYear !== startYear + 1) {
    throw new BadRequestError(`"${financialYear}" does not span consecutive years`)
  }
  return { startYear, endYear }
}

export function isValidFinancialYear(value: string): boolean {
  try {
    parseFinancialYear(value)
    return true
  } catch {
    return false
  }
}

/** The FY a given date falls in — April onward belongs to that calendar year's FY. */
export function financialYearOf(date: Date): string {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const startYear = month >= 4 ? year : year - 1
  return `${startYear}-${startYear + 1}`
}

export function currentFinancialYear(): string {
  return financialYearOf(new Date())
}

/** The calendar year a (financialYear, calendar month) pair actually falls in. */
export function calendarYearForMonth(financialYear: string, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestError(`Month must be 1-12, got ${month}`)
  }
  const { startYear, endYear } = parseFinancialYear(financialYear)
  return month >= 4 ? startYear : endYear
}

/** The Nth of a (financialYear, month) pair as a real Date (day 1, UTC midnight). */
export function monthDate(financialYear: string, month: number): Date {
  const year = calendarYearForMonth(financialYear, month)
  return new Date(Date.UTC(year, month - 1, 1))
}

/** The 12 (month, calendarYear, label) triples for an FY, in April-to-March order. */
export function financialYearMonths(
  financialYear: string,
): { month: number; calendarYear: number; label: string }[] {
  const { startYear, endYear } = parseFinancialYear(financialYear)
  const order = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]
  return order.map((month) => {
    const calendarYear = month >= 4 ? startYear : endYear
    const label = new Date(Date.UTC(calendarYear, month - 1, 1)).toLocaleString('en-US', {
      month: 'short',
      timeZone: 'UTC',
    })
    return { month, calendarYear, label: `${label} ${calendarYear}` }
  })
}

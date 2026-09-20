import { financialYearMonths, monthDate } from './financial-year.js'

/**
 * How the year's tax is spread over the months, as pure functions — no I/O,
 * so the arithmetic can be tested without a database.
 *
 * ── THE RULE
 *
 * TDS on salary is not "annual tax ÷ 12". It is what is STILL OWED, spread
 * over the months still LEFT to collect it in:
 *
 *     this month's TDS = (annual tax − TDS already deducted) ÷ months remaining
 *
 * with the current month counting as remaining. Recomputing that every month
 * is what makes it self-correcting: a raise, a new declaration or a bonus
 * changes the annual figure, and the remaining months absorb the difference
 * instead of the year ending with a shortfall or a refund.
 *
 * ── "MONTHS REMAINING" MEANS EMPLOYED MONTHS
 *
 * Someone who joined in August is paid for eight months, not twelve. Spreading
 * a year's tax over months in which they draw no salary would either deduct
 * nothing until it was too late or collect it in a lump at the end.
 */

/** When someone is on the payroll, as far as the tax year is concerned. */
export interface EmploymentWindow {
  joiningDate: Date
  /** Last working day, if one is set — including one in the future (a notice period). */
  relievingDate: Date | null
}

/**
 * The calendar months (4…12, then 1…3) of a financial year in which the
 * person is employed, in April-to-March order.
 *
 * A month counts if they were employed on ANY day of it: joining on the 20th
 * or leaving on the 5th still means that month has a payslip. Payslips here
 * are whole-month documents, so treating a part-month as no month would leave
 * someone's last pay with no tax taken from it.
 */
export function employedMonths(financialYear: string, window: EmploymentWindow): number[] {
  return financialYearMonths(financialYear)
    .filter(({ month }) => {
      const start = monthDate(financialYear, month)
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
      if (window.joiningDate > end) return false
      if (window.relievingDate && window.relievingDate < start) return false
      return true
    })
    .map(({ month }) => month)
}

export interface MonthlyTdsInput {
  /** The year's total tax liability, cess included. */
  annualLiability: number
  /** TDS already deducted this year, before this month. */
  deductedSoFar: number
  /** Employed months left to collect it in, this month included. */
  monthsRemaining: number
}

/**
 * This month's TDS in whole rupees.
 *
 * Never negative: if more has been deducted than the year's tax now comes to
 * (a smaller bonus than projected, say) the answer is nothing more to take,
 * not a refund through payroll. Getting the excess back is the employee's
 * income-tax return, not a negative number on a payslip.
 *
 * Whole rupees because TDS is deposited in them. The rounding needs no
 * special handling: because the next month recomputes from what was actually
 * deducted, a rupee rounded away in one month is picked up by the months
 * after it, and the last month collects whatever is left.
 */
export function monthlyTdsAmount({
  annualLiability,
  deductedSoFar,
  monthsRemaining,
}: MonthlyTdsInput): number {
  if (monthsRemaining <= 0) return 0
  const owed = annualLiability - deductedSoFar
  if (owed <= 0) return 0
  return Math.round(owed / monthsRemaining)
}

export interface TdsScheduleEntry {
  month: number
  amount: number
}

export interface BuildScheduleInput {
  financialYear: string
  window: EmploymentWindow
  annualLiability: number
  /** Amounts already recorded, by calendar month. Never changed by this. */
  recorded: ReadonlyMap<number, number>
  /** Fill missing months up to and including this one (calendar month, 1-12). */
  throughMonth: number
}

/**
 * The months that still need a figure, and what each should be.
 *
 * Walks the employed months in order. A month that already has an amount
 * keeps it and simply counts towards what has been deducted — a figure
 * somebody typed in, or one carried over from the old system, is not this
 * function's to second-guess. A month with no amount is calculated from
 * everything before it, in sequence, so the answer does not depend on which
 * month happened to be asked for first.
 */
export function buildTdsSchedule(input: BuildScheduleInput): TdsScheduleEntry[] {
  const months = employedMonths(input.financialYear, input.window)
  const order = financialYearMonths(input.financialYear).map((m) => m.month)
  const throughIndex = order.indexOf(input.throughMonth)
  if (throughIndex < 0) return []

  const created: TdsScheduleEntry[] = []
  let deducted = 0

  months.forEach((month, position) => {
    const recorded = input.recorded.get(month)
    if (recorded !== undefined) {
      deducted += recorded
      return
    }
    if (order.indexOf(month) > throughIndex) return

    const amount = monthlyTdsAmount({
      annualLiability: input.annualLiability,
      deductedSoFar: deducted,
      monthsRemaining: months.length - position,
    })
    created.push({ month, amount })
    deducted += amount
  })

  return created
}

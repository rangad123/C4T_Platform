import { financialYearMonths, monthDate } from './financial-year.js'

/**
 * Leave is earned month by month, not handed out on day one.
 *
 * ── THE RULE
 *
 * A leave type's yearly days are split into twelve equal monthly credits. A
 * credit lands on the 1st of a month, for everyone who was employed on that
 * day. So someone who joins in August gets no credit for August (they were not
 * there on the 1st) and their first one on 1 September: 1 casual and 1
 * privilege day, so two leaves available in September.
 *
 * Someone employed the whole year has earned six credits by 1 September and
 * twelve by 1 March. Someone who left stops earning from the month after they
 * went. A year that has not started has earned nothing, and one that has ended
 * counts every month they were there for.
 *
 * ── WHAT IT DOES NOT DO
 *
 * It does not carry days over between years, and it does not stop a request for
 * more than has been earned. Balances have only ever been shown here, never
 * enforced, and this changes what they show.
 */

/**
 * Which leave types are earned monthly: casual leave and privilege leave (which
 * this system also calls earned leave, and was migrated under that name).
 *
 * Deliberately not every type. Maternity and paternity leave are an entitlement
 * for an event, not something a person builds up a month at a time, and nobody
 * has asked for sick or unpaid leave to work this way. Those keep giving their
 * full days for the year.
 *
 * By name because there is no field to hang it on; the names are the ones HR
 * already sees, and a type that is renamed simply stops accruing until this
 * list is updated.
 */
export function accruesMonthly(leaveTypeName: string): boolean {
  return /^(casual|privilege|earned) leave$/i.test(leaveTypeName.trim())
}

export interface EmploymentSpan {
  joiningDate: Date
  /** Last working day, if one is set. */
  relievingDate: Date | null
}

/** The monthly credits earned in a financial year, as of a date. */
export function creditsEarned(financialYear: string, asOf: Date, span: EmploymentSpan): number {
  return financialYearMonths(financialYear).filter(({ month }) => {
    const first = monthDate(financialYear, month)
    if (first > asOf) return false
    if (span.joiningDate > first) return false
    if (span.relievingDate && span.relievingDate < first) return false
    return true
  }).length
}

/** Days earned so far: the yearly days spread evenly over twelve monthly credits. */
export function daysEarned(annualDays: number, credits: number): number {
  return Math.round(((annualDays * credits) / 12) * 100) / 100
}

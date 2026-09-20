/**
 * Calendar math shared by Timesheet and Leaves — the one place "how many
 * working days are in this range" is computed, so Leaves' `days` and
 * Timesheet's working/paid days can never quietly disagree with each other.
 *
 * A working day is any calendar day that is not a weekend (Sat/Sun) and not
 * a listed `HrHoliday`. No I/O here — callers pass in the holiday dates
 * already loaded for the range in question.
 */

function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay()
  return day === 0 || day === 6
}

/** Every calendar date from `start` to `end` inclusive, both UTC-midnight `Date`s. */
export function enumerateDates(start: Date, end: Date): Date[] {
  const dates: Date[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
  while (cursor <= last) {
    dates.push(new Date(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

/** Working days between `start` and `end` inclusive — excludes weekends and any date in `holidayDates`. */
export function countWorkingDays(start: Date, end: Date, holidayDates: readonly Date[]): number {
  const holidaySet = new Set(holidayDates.map(toDateOnlyString))
  return enumerateDates(start, end).filter(
    (date) => !isWeekend(date) && !holidaySet.has(toDateOnlyString(date)),
  ).length
}

/** How many days of `start`..`end` (inclusive) fall inside the given calendar month. */
export function overlapDaysInMonth(
  start: Date,
  end: Date,
  year: number,
  month: number,
  holidayDates: readonly Date[],
): number {
  const monthStart = new Date(Date.UTC(year, month - 1, 1))
  const monthEnd = new Date(Date.UTC(year, month, 0))
  const rangeStart = start > monthStart ? start : monthStart
  const rangeEnd = end < monthEnd ? end : monthEnd
  if (rangeStart > rangeEnd) return 0
  return countWorkingDays(rangeStart, rangeEnd, holidayDates)
}

/**
 * Today's calendar date in India, as UTC midnight — the way every date-only
 * column here is stored.
 *
 * India, not the server's own zone: the server runs in UTC, so between 00:00
 * and 05:30 IST "today" there is still yesterday, and someone added at 2 a.m.
 * would be given the previous day as their joining date.
 */
export function todayInIndia(now: Date = new Date()): Date {
  const iso = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  return new Date(`${iso}T00:00:00.000Z`)
}

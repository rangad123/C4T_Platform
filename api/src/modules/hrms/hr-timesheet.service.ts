import { type Prisma, HrLeaveRequestStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { calendarYearForMonth, financialYearOf } from '../../lib/hrms/financial-year.js'
import { countWorkingDays, overlapDaysInMonth } from '../../lib/hrms/hr-calendar.js'
import { listHolidayDatesForYears } from './hr-holidays.service.js'
import type { UpsertTimesheetEntryInput } from './hr-timesheet.schema.js'

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber()
}

const entrySelect = {
  id: true,
  date: true,
  description: true,
  hours: true,
  extraHours: true,
} satisfies Prisma.HrTimesheetEntrySelect

function toPublicEntry(row: Prisma.HrTimesheetEntryGetPayload<{ select: typeof entrySelect }>) {
  return { ...row, hours: toNumber(row.hours), extraHours: toNumber(row.extraHours) }
}

export async function listEntries(employeeId: string, financialYear: string, month: number) {
  const rows = await prisma.hrTimesheetEntry.findMany({
    where: { employeeId, financialYear, month },
    select: entrySelect,
    orderBy: { date: 'asc' },
  })
  return rows.map(toPublicEntry)
}

/**
 * Never accepts `financialYear`/`month` from the caller — both are derived
 * from `date` here, so an entry can never land in a month its own date
 * disagrees with.
 */
export async function upsertEntry(employeeId: string, input: UpsertTimesheetEntryInput) {
  const financialYear = financialYearOf(input.date)
  const month = input.date.getUTCMonth() + 1

  const row = await prisma.hrTimesheetEntry.upsert({
    where: { employeeId_date: { employeeId, date: input.date } },
    create: {
      employeeId,
      financialYear,
      month,
      date: input.date,
      description: input.description ?? null,
      hours: input.hours,
      extraHours: input.extraHours,
    },
    update: {
      description: input.description ?? null,
      hours: input.hours,
      extraHours: input.extraHours,
    },
    select: entrySelect,
  })
  return toPublicEntry(row)
}

export async function deleteEntry(employeeId: string, id: string): Promise<void> {
  const existing = await prisma.hrTimesheetEntry.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Timesheet entry')
  await prisma.hrTimesheetEntry.delete({ where: { id } })
}

/**
 * Working/paid days for the month — DERIVED from HrHoliday + approved
 * HrLeaveRequest + the calendar, never a stored, freely-editable field. The
 * direct fix for "do not display invalid values such as NaN": every number
 * here comes from a real computation over real rows, so there is nothing
 * left unset that could render as NaN.
 */
export async function getMonthSummary(employeeId: string, financialYear: string, month: number) {
  const year = calendarYearForMonth(financialYear, month)
  const monthStart = new Date(Date.UTC(year, month - 1, 1))
  const monthEnd = new Date(Date.UTC(year, month, 0))

  const [holidayDates, approvedLeave, entries] = await Promise.all([
    listHolidayDatesForYears([year]),
    prisma.hrLeaveRequest.findMany({
      where: {
        employeeId,
        status: HrLeaveRequestStatus.APPROVED,
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
      select: { startDate: true, endDate: true, leaveType: { select: { name: true } } },
    }),
    prisma.hrTimesheetEntry.findMany({
      where: { employeeId, financialYear, month },
      select: { hours: true, extraHours: true },
    }),
  ])

  const workingDays = countWorkingDays(monthStart, monthEnd, holidayDates)

  const unpaidLeaveDays = approvedLeave
    .filter((leave) => leave.leaveType.name === 'Unpaid leave')
    .reduce(
      (sum, leave) =>
        sum + overlapDaysInMonth(leave.startDate, leave.endDate, year, month, holidayDates),
      0,
    )

  const loggedHours = entries.reduce(
    (sum, entry) => sum + toNumber(entry.hours) + toNumber(entry.extraHours),
    0,
  )

  return {
    financialYear,
    month,
    workingDays,
    paidDays: Math.max(0, workingDays - unpaidLeaveDays),
    unpaidLeaveDays,
    loggedHours,
    entryCount: entries.length,
  }
}

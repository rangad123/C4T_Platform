import { type Prisma, HrLeaveRequestStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { countWorkingDays, todayInIndia } from '../../lib/hrms/hr-calendar.js'
import { accruesMonthly, creditsEarned, daysEarned } from '../../lib/hrms/hr-leave-accrual.js'
import { listHolidayDatesForYears } from './hr-holidays.service.js'
import { financialYearOf } from '../../lib/hrms/financial-year.js'
import { searchTerms } from '../../lib/search.js'
import { buildMeta, toSkipTake } from '../../lib/pagination.js'
import type { CreateLeaveRequestInput, ListAllLeaveRequestsQuery } from './hr-leaves.schema.js'

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber()
}

const requestSelect = {
  id: true,
  startDate: true,
  endDate: true,
  days: true,
  reason: true,
  status: true,
  decidedAt: true,
  createdAt: true,
  leaveType: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.HrLeaveRequestSelect

function toPublicRequest(row: Prisma.HrLeaveRequestGetPayload<{ select: typeof requestSelect }>) {
  return { ...row, days: toNumber(row.days) }
}

const adminRequestSelect = {
  ...requestSelect,
  employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
} satisfies Prisma.HrLeaveRequestSelect

/**
 * Every employee's requests — the admin's Leaves screen.
 *
 * Former staff are left in on purpose. Someone who resigned last month can
 * still have a request from before they went that was never decided, and
 * hiding it would leave an approval nobody could find.
 *
 * Newest first. The screen opens on the Pending filter, so "what needs
 * deciding" is what the default view already is; the total of undecided
 * requests comes back in `meta.pending` whatever the filter, so the count
 * stays honest when someone is looking at Approved or All.
 */
export async function listAllRequests(query: ListAllLeaveRequestsQuery) {
  const terms = searchTerms(query.search)
  const where: Prisma.HrLeaveRequestWhereInput = {
    employee: { deletedAt: null },
    ...(query.status ? { status: query.status } : {}),
    ...(terms.length > 0
      ? {
          AND: terms.map((term) => ({
            employee: {
              OR: [
                { firstName: { contains: term, mode: 'insensitive' as const } },
                { lastName: { contains: term, mode: 'insensitive' as const } },
                { employeeCode: { contains: term, mode: 'insensitive' as const } },
                { email: { contains: term, mode: 'insensitive' as const } },
              ],
            },
          })),
        }
      : {}),
  }

  const [items, total, pending] = await Promise.all([
    prisma.hrLeaveRequest.findMany({
      where,
      select: adminRequestSelect,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.hrLeaveRequest.count({ where }),
    prisma.hrLeaveRequest.count({
      where: { status: HrLeaveRequestStatus.PENDING, employee: { deletedAt: null } },
    }),
  ])

  return {
    items: items.map((row) => ({ ...row, days: toNumber(row.days) })),
    meta: { ...buildMeta(query, total), pending },
  }
}

/**
 * What an employee has earned, used and has left of each leave type for a year.
 *
 * Leave is EARNED, not handed out: a type's yearly days are credited in twelve
 * monthly instalments (see `hr-leave-accrual.ts`), so `allocated` is what has
 * been earned so far, and `annualDays` is the full-year figure it builds toward.
 * The field keeps its old name because the screens that read it already use it.
 *
 * A balance row an administrator has set for the year is a fixed allocation and
 * wins outright: it is how HR grants something outside the monthly rule, and
 * it does not accrue.
 */
export async function getBalances(employeeId: string, financialYear: string) {
  const leaveTypes = await prisma.hrLeaveType.findMany({
    where: { isActive: true },
    select: { id: true, name: true, defaultAnnualDays: true },
    orderBy: { name: 'asc' },
  })

  const employee = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { joiningDate: true, relievingDate: true },
  })
  if (!employee) throw new NotFoundError('Employee')
  const credits = creditsEarned(financialYear, todayInIndia(), employee)

  const [balanceRows, approvedRows] = await Promise.all([
    prisma.hrLeaveBalance.findMany({
      where: { employeeId, financialYear, leaveTypeId: { in: leaveTypes.map((t) => t.id) } },
      select: { leaveTypeId: true, allocated: true },
    }),
    prisma.hrLeaveRequest.findMany({
      where: { employeeId, status: HrLeaveRequestStatus.APPROVED },
      select: { leaveTypeId: true, days: true, startDate: true },
    }),
  ])

  const allocatedByType = new Map(
    balanceRows.map((row) => [row.leaveTypeId, toNumber(row.allocated)]),
  )
  // "Used" is computed from approved requests, never a stored running total —
  // see the schema's own doc comment on HrLeaveBalance.
  const usedByType = new Map<string, number>()
  for (const row of approvedRows) {
    if (financialYearOf(row.startDate) !== financialYear) continue
    usedByType.set(row.leaveTypeId, (usedByType.get(row.leaveTypeId) ?? 0) + toNumber(row.days))
  }

  return leaveTypes.map((type) => {
    const fixed = allocatedByType.get(type.id)
    const accrues = fixed === undefined && accruesMonthly(type.name)
    const allocated =
      fixed ?? (accrues ? daysEarned(type.defaultAnnualDays, credits) : type.defaultAnnualDays)
    const used = usedByType.get(type.id) ?? 0
    return {
      leaveType: { id: type.id, name: type.name },
      allocated,
      annualDays: fixed ?? type.defaultAnnualDays,
      accruesMonthly: accrues,
      used,
      remaining: Math.round((allocated - used) * 100) / 100,
    }
  })
}

export async function listRequests(employeeId: string) {
  const rows = await prisma.hrLeaveRequest.findMany({
    where: { employeeId },
    select: requestSelect,
    orderBy: { startDate: 'desc' },
  })
  return rows.map(toPublicRequest)
}

async function computeDays(startDate: Date, endDate: Date): Promise<number> {
  const years = Array.from(new Set([startDate.getUTCFullYear(), endDate.getUTCFullYear()]))
  const holidayDates = await listHolidayDatesForYears(years)
  return countWorkingDays(startDate, endDate, holidayDates)
}

export async function createLeaveRequest(employeeId: string, input: CreateLeaveRequestInput) {
  const leaveType = await prisma.hrLeaveType.findFirst({
    where: { id: input.leaveTypeId, isActive: true },
    select: { id: true },
  })
  if (!leaveType) throw new NotFoundError('Leave type')

  const days = await computeDays(input.startDate, input.endDate)
  if (days <= 0) {
    throw new BadRequestError('That date range has no working days to request leave for')
  }

  const row = await prisma.hrLeaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      days,
      reason: input.reason ?? null,
      status: HrLeaveRequestStatus.PENDING,
    },
    select: requestSelect,
  })
  return toPublicRequest(row)
}

export async function cancelLeaveRequest(employeeId: string, id: string) {
  const existing = await prisma.hrLeaveRequest.findUnique({
    where: { id },
    select: { id: true, employeeId: true, status: true },
  })
  if (!existing) throw new NotFoundError('Leave request')
  if (existing.employeeId !== employeeId) {
    throw new ForbiddenError('You do not have access to this leave request')
  }
  if (
    existing.status === HrLeaveRequestStatus.REJECTED ||
    existing.status === HrLeaveRequestStatus.CANCELLED
  ) {
    throw new BadRequestError('This request can no longer be cancelled')
  }

  const row = await prisma.hrLeaveRequest.update({
    where: { id },
    data: { status: HrLeaveRequestStatus.CANCELLED },
    select: requestSelect,
  })
  return toPublicRequest(row)
}

export async function decideLeaveRequest(
  employeeId: string,
  requestId: string,
  decidedById: string,
  status: 'APPROVED' | 'REJECTED',
) {
  const existing = await prisma.hrLeaveRequest.findUnique({
    where: { id: requestId },
    select: { id: true, employeeId: true, status: true },
  })
  if (existing?.employeeId !== employeeId) throw new NotFoundError('Leave request')
  if (existing.status !== HrLeaveRequestStatus.PENDING) {
    throw new BadRequestError('This request has already been decided')
  }

  const row = await prisma.hrLeaveRequest.update({
    where: { id: requestId },
    data: { status, decidedById, decidedAt: new Date() },
    select: requestSelect,
  })
  return toPublicRequest(row)
}

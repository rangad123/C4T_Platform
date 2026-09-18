import { type Prisma, HrLeaveRequestStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { countWorkingDays } from '../../lib/hrms/hr-calendar.js'
import { listHolidayDatesForYears } from './hr-holidays.service.js'
import { financialYearOf } from '../../lib/hrms/financial-year.js'
import type { CreateLeaveRequestInput } from './hr-leaves.schema.js'

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

export async function getBalances(employeeId: string, financialYear: string) {
  const leaveTypes = await prisma.hrLeaveType.findMany({
    where: { isActive: true },
    select: { id: true, name: true, defaultAnnualDays: true },
    orderBy: { name: 'asc' },
  })

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
    const allocated = allocatedByType.get(type.id) ?? type.defaultAnnualDays
    const used = usedByType.get(type.id) ?? 0
    return {
      leaveType: { id: type.id, name: type.name },
      allocated,
      used,
      remaining: allocated - used,
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

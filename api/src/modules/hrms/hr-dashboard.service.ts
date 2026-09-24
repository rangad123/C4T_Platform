import { HrEmployeeStatus, HrLeaveRequestStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { listHolidays } from './hr-holidays.service.js'
import { todayInIndia } from '../../lib/hrms/hr-calendar.js'

export interface AdminDashboardStats {
  activeEmployees: number
  resignedThisMonth: number
  upcomingHolidaysThisMonth: { id: string; date: string; name: string }[]
  leavesAppliedThisMonth: number
  pendingLeaveApprovals: number
}

/**
 * Everything the Admin dashboard's KPI row and reminders panel need, in one
 * call rather than one route per number — the numbers are cheap counts and
 * one short list, not worth a network round trip each.
 */
export async function getAdminDashboardStats(): Promise<AdminDashboardStats> {
  const today = todayInIndia()
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth()
  const startOfMonth = new Date(Date.UTC(year, month, 1))
  const startOfNextMonth = new Date(Date.UTC(year, month + 1, 1))

  const [
    activeEmployees,
    resignedThisMonth,
    holidaysThisYear,
    leavesAppliedThisMonth,
    pendingLeaveApprovals,
  ] = await Promise.all([
    prisma.hrEmployee.count({
      where: { status: HrEmployeeStatus.ACTIVE, deletedAt: null },
    }),
    prisma.hrEmployee.count({
      where: {
        status: { in: [HrEmployeeStatus.RESIGNED, HrEmployeeStatus.TERMINATED] },
        relievingDate: { gte: startOfMonth, lt: startOfNextMonth },
      },
    }),
    listHolidays(year),
    prisma.hrLeaveRequest.count({
      where: { createdAt: { gte: startOfMonth, lt: startOfNextMonth } },
    }),
    prisma.hrLeaveRequest.count({ where: { status: HrLeaveRequestStatus.PENDING } }),
  ])

  const upcomingHolidaysThisMonth = holidaysThisYear
    .filter((holiday) => holiday.date >= today && holiday.date < startOfNextMonth)
    .map((holiday) => ({ id: holiday.id, date: holiday.date.toISOString(), name: holiday.name }))

  return {
    activeEmployees,
    resignedThisMonth,
    upcomingHolidaysThisMonth,
    leavesAppliedThisMonth,
    pendingLeaveApprovals,
  }
}

import { z } from 'zod'
import { HrLeaveRequestStatus } from '@prisma/client'
import { isValidFinancialYear } from '../../lib/hrms/financial-year.js'
import { paginationQuery } from '../../lib/pagination.js'

const financialYearField = z
  .string()
  .trim()
  .refine(isValidFinancialYear, 'Financial year must look like "2026-2027"')

export const financialYearQuery = z.object({ financialYear: financialYearField })

export const employeeIdParam = z.object({ id: z.string().cuid() })
export const leaveRequestIdParam = z.object({ id: z.string().cuid() })
export const employeeLeaveRequestParam = z.object({
  id: z.string().cuid(),
  reqId: z.string().cuid(),
})

export const createLeaveRequestSchema = z
  .object({
    leaveTypeId: z.string().cuid(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'End date must be on or after the start date',
    path: ['endDate'],
  })

/**
 * Every employee's leave requests, for the admin's own Leaves screen.
 *
 * `status` is optional so "All" is expressible; the screen defaults to PENDING
 * because approving is what an admin comes here to do.
 */
export const listAllLeaveRequestsQuery = paginationQuery.extend({
  status: z.nativeEnum(HrLeaveRequestStatus).optional(),
  search: z.string().trim().max(120).optional(),
})

export const decideLeaveRequestSchema = z.object({
  status: z.enum([HrLeaveRequestStatus.APPROVED, HrLeaveRequestStatus.REJECTED]),
})

export type ListAllLeaveRequestsQuery = z.infer<typeof listAllLeaveRequestsQuery>
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>
export type FinancialYearQuery = z.infer<typeof financialYearQuery>

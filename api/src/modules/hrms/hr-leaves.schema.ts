import { z } from 'zod'
import { HrLeaveRequestStatus } from '@prisma/client'
import { isValidFinancialYear } from '../../lib/hrms/financial-year.js'

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

export const decideLeaveRequestSchema = z.object({
  status: z.enum([HrLeaveRequestStatus.APPROVED, HrLeaveRequestStatus.REJECTED]),
})

export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>
export type FinancialYearQuery = z.infer<typeof financialYearQuery>

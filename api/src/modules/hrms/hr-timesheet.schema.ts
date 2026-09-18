import { z } from 'zod'
import { isValidFinancialYear } from '../../lib/hrms/financial-year.js'

const financialYearField = z
  .string()
  .trim()
  .refine(isValidFinancialYear, 'Financial year must look like "2026-2027"')

export const financialYearMonthQuery = z.object({
  financialYear: financialYearField,
  month: z.coerce.number().int().min(1).max(12),
})

export const employeeIdParam = z.object({ id: z.string().cuid() })
export const entryIdParam = z.object({ id: z.string().cuid() })

export const upsertTimesheetEntrySchema = z.object({
  date: z.coerce.date(),
  description: z.string().trim().max(500).optional(),
  hours: z.coerce.number().min(0).max(24),
  extraHours: z.coerce.number().min(0).max(24),
})

export type FinancialYearMonthQuery = z.infer<typeof financialYearMonthQuery>
export type UpsertTimesheetEntryInput = z.infer<typeof upsertTimesheetEntrySchema>

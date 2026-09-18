import { z } from 'zod'
import { isValidFinancialYear } from '../../lib/hrms/financial-year.js'

const financialYearField = z
  .string()
  .trim()
  .refine(isValidFinancialYear, 'Financial year must look like "2026-2027"')

export const employeeIdParam = z.object({ id: z.string().cuid() })
export const employeeSubResourceParam = z.object({
  id: z.string().cuid(),
  subId: z.string().cuid(),
})

export const financialYearQuery = z.object({ financialYear: financialYearField })

/**
 * `basic`/`hra`/`specialAllowance` and the three incentive fields are the
 * only inputs a caller ever sends — `totalFixedAnnual`/`totalVariableAnnual`
 * are always SERVER-COMPUTED sums (see hr-salary.service.ts), never accepted
 * from the client. That is the direct fix for the brief's "calculate totals
 * automatically instead of allowing inconsistent totals."
 */
export const upsertSalaryStructureSchema = z.object({
  financialYear: financialYearField,
  basic: z.coerce.number().min(0).max(99_999_999),
  hra: z.coerce.number().min(0).max(99_999_999),
  specialAllowance: z.coerce.number().min(0).max(99_999_999),
  performanceIncentive: z.coerce.number().min(0).max(99_999_999),
  projectIncentive: z.coerce.number().min(0).max(99_999_999),
  extraHoursIncentive: z.coerce.number().min(0).max(99_999_999),
})

export const createOldSalarySchema = z
  .object({
    ctc: z.coerce.number().min(0).max(99_999_999),
    fromDate: z.coerce.date(),
    toDate: z.coerce.date(),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: 'End date must be on or after the start date' })

export const createMonthlyIncentiveSchema = z.object({
  financialYear: financialYearField,
  month: z.coerce.number().int().min(1).max(12),
  incentiveTypeId: z.string().cuid(),
  amount: z.coerce.number().min(0).max(99_999_999),
})

export type UpsertSalaryStructureInput = z.infer<typeof upsertSalaryStructureSchema>
export type CreateOldSalaryInput = z.infer<typeof createOldSalarySchema>
export type CreateMonthlyIncentiveInput = z.infer<typeof createMonthlyIncentiveSchema>

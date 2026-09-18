import { z } from 'zod'
import { isValidFinancialYear } from '../../lib/hrms/financial-year.js'

const financialYearField = z
  .string()
  .trim()
  .refine(isValidFinancialYear, 'Financial year must look like "2026-2027"')

export const employeeIdParam = z.object({ id: z.string().cuid() })

export const generatePayslipSchema = z.object({
  financialYear: financialYearField,
  month: z.coerce.number().int().min(1).max(12),
})

export const payslipQuery = generatePayslipSchema

export type GeneratePayslipInput = z.infer<typeof generatePayslipSchema>

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

export const createDeclarationSchema = z.object({
  financialYear: financialYearField,
  sectionId: z.string().cuid(),
  description: z.string().trim().max(500).optional(),
  declaredAmount: z.coerce.number().min(0).max(9_999_999),
})

export const updateDeclarationSchema = z.object({
  description: z.string().trim().max(500).optional(),
  declaredAmount: z.coerce.number().min(0).max(9_999_999).optional(),
})

/** A verified amount of 0 is a legitimate "reviewed, nothing allowed" outcome — kept distinct from "not yet verified" (null). */
export const verifyDeclarationSchema = z.object({
  verifiedAmount: z.coerce.number().min(0).max(9_999_999),
})

export const createMonthlyDeductionSchema = z.object({
  financialYear: financialYearField,
  month: z.coerce.number().int().min(1).max(12),
  amount: z.coerce.number().min(0).max(9_999_999),
})

export type CreateDeclarationInput = z.infer<typeof createDeclarationSchema>
export type UpdateDeclarationInput = z.infer<typeof updateDeclarationSchema>
export type CreateMonthlyDeductionInput = z.infer<typeof createMonthlyDeductionSchema>

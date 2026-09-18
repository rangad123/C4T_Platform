import { z } from 'zod'
import { HrTaxRegime } from '@prisma/client'
import { isValidFinancialYear } from '../../lib/hrms/financial-year.js'

const financialYearField = z
  .string()
  .trim()
  .refine(isValidFinancialYear, 'Financial year must look like "2026-2027"')

export const employeeIdParam = z.object({ id: z.string().cuid() })

export const financialYearQuery = z.object({ financialYear: financialYearField })

export const taxSlabBandSchema = z
  .object({
    /** Upper bound of taxable income for this band, or `null` for "and above". */
    upTo: z.coerce.number().positive().nullable(),
    /** Percentage rate applied to the portion of income inside this band. */
    rate: z.coerce.number().min(0).max(100),
  })
  .array()
  .min(1)

export const upsertTaxSlabSchema = z.object({
  financialYear: financialYearField,
  regime: z.nativeEnum(HrTaxRegime),
  slabs: taxSlabBandSchema,
  standardDeduction: z.coerce.number().min(0).max(9_999_999),
  cessRatePercent: z.coerce.number().min(0).max(100),
  rebate87ALimit: z.coerce.number().min(0).max(99_999_999),
  rebate87AMaxAmount: z.coerce.number().min(0).max(9_999_999),
})

export const taxSlabIdParam = z.object({ id: z.string().cuid() })

export type UpsertTaxSlabInput = z.infer<typeof upsertTaxSlabSchema>

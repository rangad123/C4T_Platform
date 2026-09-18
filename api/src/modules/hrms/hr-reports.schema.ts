import { z } from 'zod'
import { isValidFinancialYear } from '../../lib/hrms/financial-year.js'

const financialYearField = z
  .string()
  .trim()
  .refine(isValidFinancialYear, 'Financial year must look like "2026-2027"')

export const REPORT_TYPES = ['TIMESHEET', 'TDS', 'PT'] as const
export const REPORT_PERIODS = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const

/**
 * An empty string, not `undefined`, for whichever of month/quarter the
 * chosen period doesn't use — the browser's plain GET report form always
 * submits every named field it has, relevant or not, since there is no JS
 * disabling the other one based on the period picked. `z.coerce.number()`
 * turns `''` into `0`, which then fails `.min(1)` instead of being treated
 * as "not provided" — caught by generating the report through that actual
 * form rather than only against curl calls that never left a field blank.
 */
const optionalInteger = (min: number, max: number) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(min).max(max).optional(),
  )

export const generateReportQuery = z
  .object({
    financialYear: financialYearField,
    reportType: z.enum(REPORT_TYPES),
    period: z.enum(REPORT_PERIODS),
    month: optionalInteger(1, 12),
    quarter: optionalInteger(1, 4),
  })
  .refine((v) => v.period !== 'MONTHLY' || v.month !== undefined, {
    message: 'month is required for a monthly report',
    path: ['month'],
  })
  .refine((v) => v.period !== 'QUARTERLY' || v.quarter !== undefined, {
    message: 'quarter is required for a quarterly report',
    path: ['quarter'],
  })

export type GenerateReportQuery = z.infer<typeof generateReportQuery>

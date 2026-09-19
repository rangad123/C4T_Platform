import { z } from 'zod'
import { HrRole, HrGender, HrEmployeeStatus, HrTaxRegime } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'
import { phoneField } from '../../lib/phone.js'

/** `[A-Z]{5}[0-9]{4}[A-Z]` — the fixed Indian PAN format, e.g. "ABCDE1234F". */
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/
/** `[A-Z]{4}0[A-Z0-9]{6}` — the fixed IFSC format, e.g. "HDFC0001234". */
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/

const panField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PAN_REGEX, 'Enter a valid PAN, e.g. ABCDE1234F')
const ifscField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(IFSC_REGEX, 'Enter a valid IFSC code, e.g. HDFC0001234')

export const EMPLOYEE_SORT_FIELDS = [
  'createdAt',
  'firstName',
  'employeeCode',
  'joiningDate',
  'role',
  'status',
] as const

export const listEmployeesQuery = paginationQuery.extend({
  role: z.nativeEnum(HrRole).optional(),
  status: z.nativeEnum(HrEmployeeStatus).optional(),
  /** True = resigned/terminated staff ("Old employees"); false/absent = active only. */
  former: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(EMPLOYEE_SORT_FIELDS).optional(),
})

/** Shared by create and update — every field an admin can actually type in. */
const employeeFields = {
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.nativeEnum(HrGender).optional(),
  phone: phoneField.optional(),
  address: z.string().trim().max(500).optional(),

  designationId: z.string().cuid().optional(),
  role: z.nativeEnum(HrRole).default(HrRole.EMPLOYEE),
  /** Free text — see the schema's own doc comment on why this isn't a catalog. */
  accountType: z.string().trim().max(40).optional(),
  reportsToId: z.string().cuid().optional(),
  joiningDate: z.coerce.date(),
  timesheetRequired: z.boolean().default(true),

  taxRegime: z.nativeEnum(HrTaxRegime).default(HrTaxRegime.NEW),
  panNumber: panField.optional(),
  accountNumber: z.string().trim().min(4).max(34).optional(),
  accountName: z.string().trim().max(120).optional(),
  ifscCode: ifscField.optional(),
  bankName: z.string().trim().max(120).optional(),
  branchName: z.string().trim().max(120).optional(),
}

export const createEmployeeSchema = z.object({
  ...employeeFields,
  email: z.string().trim().toLowerCase().email().max(255),
  /**
   * Optional: leave it out and the new employee is emailed an invitation to
   * choose their own. That is the better default — a password an admin types
   * has to be passed on by hand, which in practice means a chat message that
   * stays readable forever. It stays available because the admin may be
   * standing next to the new starter, or the address may not work yet.
   */
  password: z.string().min(12).max(200).optional(),
})

/**
 * Email and password are immutable through this route — email because it is
 * the sign-in identity (a typo fix is rare enough to not warrant silently
 * reusing this endpoint for it), password because that already has its own,
 * differently-audited path (the employee's own change-password, or a future
 * admin reset-password action).
 */
export const updateEmployeeSchema = z
  .object({
    ...employeeFields,
    profilePictureFileId: z.string().cuid().nullable().optional(),
    /**
     * Editable, unlike the password. An employee signs in with this, so a typo
     * at creation time locked the account permanently: they could not sign in
     * and no admin screen could correct it. The service re-checks uniqueness.
     */
    email: z.string().trim().toLowerCase().email().max(255),
  })
  .partial()

export const changeEmployeeStatusSchema = z.object({
  status: z.nativeEnum(HrEmployeeStatus),
  /** Required when moving to RESIGNED/TERMINATED; ignored for ACTIVE. */
  relievingDate: z.coerce.date().optional(),
})

export const revealFinancialDetailsSchema = z.object({
  /** Step-up: the ADMIN's own HR password, not the employee's. */
  password: z.string().min(1),
})

export const employeeIdParam = z.object({ id: z.string().cuid() })

export type ListEmployeesQuery = z.infer<typeof listEmployeesQuery>
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>

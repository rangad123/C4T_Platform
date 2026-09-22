import { z } from 'zod'
import { HrRole, HrGender, HrEmployeeStatus, HrTaxRegime, CrmRole } from '@prisma/client'
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
  /** The module switch — same idea as `timesheetRequired`, above. */
  crmEnabled: z.boolean().default(false),
  /**
   * Only meaningful while `crmEnabled` is true, but accepted independently of
   * it: an admin may set the tier first and flip the switch a moment later,
   * or leave it configured while briefly switching CRM off. `null` clears it
   * (matches `relievingDate`'s own convention on this same schema).
   */
  crmRole: z.nativeEnum(CrmRole).nullable().optional(),

  taxRegime: z.nativeEnum(HrTaxRegime).default(HrTaxRegime.NEW),
  panNumber: panField.optional(),
  accountNumber: z.string().trim().min(4).max(34).optional(),
  accountName: z.string().trim().max(120).optional(),
  ifscCode: ifscField.optional(),
  bankName: z.string().trim().max(120).optional(),
  branchName: z.string().trim().max(120).optional(),
}

/**
 * What HR types to add someone: who they are and what they may do.
 *
 * Everything else is deliberately absent. The new starter is emailed a link to
 * choose their own password and then fills in their own personal and bank
 * details (see `updateOwnDetailsSchema`); HR sets the employment side
 * (designation, reporting line, joining date, and so on) from the record.
 * Collecting it all up front meant HR typing details they often do not have,
 * and typing a password to pass on by hand.
 */
export const createEmployeeSchema = z.object({
  firstName: employeeFields.firstName,
  lastName: employeeFields.lastName,
  email: z.string().trim().toLowerCase().email().max(255),
  role: employeeFields.role,
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
    /**
     * The last working day, set or corrected independently of a status change.
     *
     * Until this existed the only way to record one was to move someone to
     * Resigned or Terminated, so a notice period could not be captured on a
     * person who was still working, and a mistyped date could not be fixed
     * without flipping their status back and forth. `null` clears it.
     */
    relievingDate: z.coerce.date().nullable().optional(),
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

/** Bank and tax details: changing them moves someone's pay, so they need a password. */
export const OWN_FINANCIAL_KEYS = [
  'panNumber',
  'accountNumber',
  'accountName',
  'ifscCode',
  'bankName',
  'branchName',
] as const

/**
 * What an employee may fill in about themselves after accepting their
 * invitation: personal details, and PAN and bank details.
 *
 * Not name, email, role or anything about their employment — those are HR's.
 * Any bank or PAN field also needs `currentPassword`, the same step-up the
 * reveal route asks HR for: a stolen session should not be able to redirect a
 * salary without knowing the password.
 */
export const updateOwnDetailsSchema = z
  .object({
    dateOfBirth: employeeFields.dateOfBirth,
    gender: employeeFields.gender,
    phone: employeeFields.phone,
    address: employeeFields.address,
    /**
     * No password needed, unlike the bank/PAN group below: a photo is not a
     * secret an account takeover would want, and requiring one here would
     * just be friction on the one detail every new starter fills in first.
     */
    profilePictureFileId: z.string().cuid().nullable().optional(),
    panNumber: employeeFields.panNumber,
    accountNumber: employeeFields.accountNumber,
    accountName: employeeFields.accountName,
    ifscCode: employeeFields.ifscCode,
    bankName: employeeFields.bankName,
    branchName: employeeFields.branchName,
    currentPassword: z.string().min(1).max(200).optional(),
  })
  .refine(
    (value) =>
      !OWN_FINANCIAL_KEYS.some((key) => value[key] !== undefined) || Boolean(value.currentPassword),
    { path: ['currentPassword'], message: 'Enter your password to save bank or PAN details' },
  )

/**
 * HR sets a temporary password for someone: either one they type, or, left
 * blank, a strong one generated for them. Twelve characters is the same floor
 * every other password in HRMS has.
 */
export const setTemporaryPasswordSchema = z.object({
  password: z.string().min(12).max(200).optional(),
})

export type ListEmployeesQuery = z.infer<typeof listEmployeesQuery>
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>
export type UpdateOwnDetailsInput = z.infer<typeof updateOwnDetailsSchema>

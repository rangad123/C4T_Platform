import { z } from 'zod'
import { CrmLeadStatus } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'
import { phoneField } from '../../lib/phone.js'

/** `\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]` — the fixed 15-character GSTIN format. */
const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_REGEX, 'Enter a valid 15-character GSTIN')

export const LEAD_SORT_FIELDS = ['createdAt', 'updatedAt', 'companyName', 'status'] as const

/** Every field a lead's Basic Details panel can set, shared by create and update. */
const leadFields = {
  companyName: z.string().trim().min(1, 'A company name is required').max(160),
  companySize: z.string().trim().max(40).optional(),
  website: z.string().trim().url('Enter a valid URL').max(255).optional(),
  industryId: z.string().cuid().nullable().optional(),
  leadSourceId: z.string().cuid().nullable().optional(),
  /** ISO 3166-1 alpha-2, same convention as the platform's own country pickers. */
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .length(2, 'Use a two-letter country code')
    .nullable()
    .optional(),
  location: z.string().trim().max(160).optional(),
  registeredOrgName: z.string().trim().max(200).optional(),
  registeredAddress: z.string().trim().max(1000).optional(),
  gstin: gstinField.optional(),
}

/**
 * `assignedToId` is accepted here but the service only honours it for a
 * caller who holds `assign_leads` — an EMPLOYEE-tier create always lands on
 * themselves regardless of what this carries. `null` means "leave
 * unassigned", distinct from omitting the key.
 */
export const createLeadSchema = z.object({
  ...leadFields,
  assignedToId: z.string().cuid().nullable().optional(),
})

export const updateLeadSchema = z.object(leadFields).partial()

export const changeLeadStatusSchema = z.object({ status: z.nativeEnum(CrmLeadStatus) })

export const assignLeadSchema = z.object({ assignedToId: z.string().cuid().nullable() })

export const addLeadActivitySchema = z.object({
  body: z.string().trim().min(1, 'Write a note before saving').max(4000),
  /** Tags this note with how the communication attempt went (DNP1, DNP2, ...) — optional. */
  communicationStatusId: z.string().cuid().optional(),
})

export const leadIdParam = z.object({ id: z.string().cuid() })

/**
 * Comma-separated multi-select, the shape a URL query string naturally
 * carries (`?status=HOT,WARM`) and the shape the filter-chip UI reads back.
 */
function commaSeparated<T extends z.ZodTypeAny>(schema: T) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(schema))
    .optional()
}

export const listLeadsQuery = paginationQuery.extend({
  sort: z.enum(LEAD_SORT_FIELDS).optional(),
  search: z.string().trim().max(120).optional(),
  status: commaSeparated(z.nativeEnum(CrmLeadStatus)),
  industryId: z.string().cuid().optional(),
  leadSourceId: z.string().cuid().optional(),
  countryCode: z.string().trim().toUpperCase().length(2).optional(),
  /** A real employee id, or the literal "unassigned" for `assignedToId IS NULL`. */
  assignedToId: z.string().min(1).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  updatedFrom: z.coerce.date().optional(),
  updatedTo: z.coerce.date().optional(),
  lastActivityFrom: z.coerce.date().optional(),
  lastActivityTo: z.coerce.date().optional(),
})

export const createContactSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(120),
  designation: z.string().trim().max(120).optional(),
  phone: phoneField.optional(),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  profileUrl: z.string().trim().url('Enter a valid URL').max(255).optional(),
})

export const updateContactSchema = createContactSchema.partial()

export const contactIdParam = z.object({ id: z.string().cuid(), contactId: z.string().cuid() })

export type CreateLeadInput = z.infer<typeof createLeadSchema>
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>
export type ListLeadsQuery = z.infer<typeof listLeadsQuery>
export type CreateContactInput = z.infer<typeof createContactSchema>
export type UpdateContactInput = z.infer<typeof updateContactSchema>

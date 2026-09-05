import { z } from 'zod'
import { phoneField } from '../../lib/phone.js'
import { OrganisationStatus, OrgMemberRole } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'
import { ISO_COUNTRY_CODES } from '../../lib/iso-countries.js'

export const ORG_SORT_FIELDS = ['createdAt', 'name', 'status', 'updatedAt'] as const

export const listOrganisationsQuery = paginationQuery.extend({
  status: z.nativeEnum(OrganisationStatus).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(ORG_SORT_FIELDS).optional(),
})

const orgProfileFields = {
  website: z.string().trim().url().max(255).optional().or(z.literal('')),
  industry: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().toLowerCase().email().max(255).optional(),
  contactPhone: phoneField.optional(),
  addressLine1: z.string().trim().max(255).optional(),
  addressLine2: z.string().trim().max(255).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(20).optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .toUpperCase()
    .refine((c) => ISO_COUNTRY_CODES.has(c), 'Not a valid ISO 3166-1 country code')
    .optional(),
  taxId: z.string().trim().max(40).optional(),
  logoFileId: z.string().cuid().optional().nullable(),
}

export const createOrganisationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  status: z.nativeEnum(OrganisationStatus).default(OrganisationStatus.PENDING),
  notes: z.string().trim().max(4000).optional(),
  /** Optionally attach an existing user as the organisation owner. */
  ownerUserId: z.string().cuid().optional(),
  ...orgProfileFields,
})

/** Fields an organisation OWNER may edit on their own record (§2.4). */
export const updateOwnOrganisationSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  ...orgProfileFields,
})

/** Admin may additionally change status and internal notes. */
export const updateOrganisationSchema = updateOwnOrganisationSchema.extend({
  status: z.nativeEnum(OrganisationStatus).optional(),
  notes: z.string().trim().max(4000).optional(),
})

export const addMemberSchema = z.object({
  userId: z.string().cuid(),
  orgRole: z.nativeEnum(OrgMemberRole).default(OrgMemberRole.MEMBER),
})

export const updateMemberSchema = z.object({
  orgRole: z.nativeEnum(OrgMemberRole),
})

export const orgIdParam = z.object({ id: z.string().cuid() })

/** §42 — the Invite New Team Member modal. */
export const inviteMemberSchema = z.object({
  email: z.string().trim().email().max(255),
  orgRole: z.nativeEnum(OrgMemberRole).optional(),
  /** The inviter's personal note, shown in the email. */
  message: z.string().trim().max(1000).optional(),
})

export const orgInvitationParam = z.object({
  id: z.string().cuid(),
  invitationId: z.string().cuid(),
})

export const acceptInvitationSchema = z.object({
  token: z.string().trim().min(10).max(500),
})
export const orgMemberParam = z.object({ id: z.string().cuid(), userId: z.string().cuid() })

export type ListOrganisationsQuery = z.infer<typeof listOrganisationsQuery>

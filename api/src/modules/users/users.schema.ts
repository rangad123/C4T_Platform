import { z } from 'zod'
import { Role, UserStatus } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'
import { phoneField } from '../../lib/phone.js'

export const USER_SORT_FIELDS = ['createdAt', 'email', 'role', 'status', 'lastLoginAt'] as const

export const listUsersQuery = paginationQuery.extend({
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(USER_SORT_FIELDS).optional(),
})

/** Admin-created accounts, including Sub-Admins (§2.2). */
export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(12).max(200),
  role: z.nativeEnum(Role),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  phone: phoneField.optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  /** Only meaningful for SUB_ADMIN; ignored otherwise. */
  permissionCodes: z.array(z.string().trim().max(80)).max(60).optional(),
  /** Skip the verification email and activate immediately. */
  activateImmediately: z.boolean().default(true),
})

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  phone: phoneField.optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  timezone: z.string().trim().max(60).optional(),
  avatarFileId: z.string().cuid().nullable().optional(),
})

/** Own-profile edits — same shape, but a user cannot change their own role. */
export const updateOwnProfileSchema = updateUserSchema

export const changeUserRoleSchema = z.object({
  role: z.nativeEnum(Role),
})

export const changeUserStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
  reason: z.string().trim().max(1000).optional(),
})

export const setPermissionsSchema = z.object({
  /** Full replacement set of permission codes. */
  permissionCodes: z.array(z.string().trim().max(80)).max(60),
})

export const userIdParam = z.object({ id: z.string().cuid() })

export type ListUsersQuery = z.infer<typeof listUsersQuery>

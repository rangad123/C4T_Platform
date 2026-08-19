import { z } from 'zod'
import { TesterStatus, DeviceType } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'

export const TESTER_SORT_FIELDS = [
  'createdAt',
  'ratingAverage',
  'bugsReportedCount',
  'projectsCompletedCount',
  'status',
] as const

export const listTestersQuery = paginationQuery.extend({
  status: z.nativeEnum(TesterStatus).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  /** Comma-separated skill slugs — all must be present. */
  skills: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  /** Comma-separated ISO 639-1 codes — any match. */
  languages: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  deviceType: z.nativeEnum(DeviceType).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(TESTER_SORT_FIELDS).optional(),
})

export const updateTesterProfileSchema = z.object({
  headline: z.string().trim().max(160).optional(),
  bio: z.string().trim().max(4000).optional(),
  experienceYears: z.coerce.number().int().min(0).max(60).optional(),
  city: z.string().trim().max(120).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
})

/** §2.2 — Admin verifies, rejects or suspends a tester. */
export const changeTesterStatusSchema = z
  .object({
    status: z.nativeEnum(TesterStatus),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((d) => d.status !== TesterStatus.REJECTED || !!d.reason, {
    message: 'A reason is required when rejecting a tester',
    path: ['reason'],
  })

export const deviceSchema = z.object({
  type: z.nativeEnum(DeviceType),
  manufacturer: z.string().trim().max(80).optional(),
  model: z.string().trim().min(1).max(120),
  osName: z.string().trim().max(60).optional(),
  osVersion: z.string().trim().max(40).optional(),
  screenSize: z.string().trim().max(40).optional(),
  ramGb: z.string().trim().max(20).optional(),
  storageGb: z.string().trim().max(20).optional(),
  network: z.string().trim().max(80).optional(),
  browser: z.string().trim().max(80).optional(),
  isPrimary: z.boolean().default(false),
  /**
   * Catalog selections, alongside the free-text fields above rather than
   * replacing them — see the schema comment on `TesterDevice`. When present,
   * the service resolves each id to its catalog row and mirrors the name into
   * the matching free-text field, so existing rendering code (which reads the
   * free-text fields) needs no changes and a catalog-backed device still
   * supports "find every tester on Android 15" matching.
   */
  deviceModelId: z.string().cuid().optional(),
  osVersionRefId: z.string().cuid().optional(),
  primaryNetworkId: z.string().cuid().optional(),
  secondaryNetworkId: z.string().cuid().optional(),
})

export const DEVICE_SORT_FIELDS = ['createdAt', 'model', 'manufacturer'] as const

/**
 * Admin-only, cross-tenant device/browser catalogue (§18 "Global Assets
 * Management"). There is no separate reference-catalogue entity in this
 * schema — legacy's "Devices"/"Browsers" assets are, in this platform, just
 * every tester's own `TesterDevice` rows viewed in aggregate. `onlyWithBrowser`
 * powers the "Browsers" tab: same rows, filtered to ones that recorded a
 * browser, so the two legacy tabs are one dataset with two lenses rather than
 * two separately-maintained tables.
 */
export const listGlobalDevicesQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
  type: z.nativeEnum(DeviceType).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  onlyWithBrowser: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
})

/**
 * Full replacement set, by catalog id — not free text. A tester picks from
 * the skill catalog (`GET /v1/catalog`); they no longer type a skill name
 * into existence, so there is nothing here to upsert against a global table.
 * See `catalog.routes.ts` for admin-side skill/category creation.
 */
export const skillsSchema = z.object({
  skillIds: z.array(z.string().cuid()).max(40),
})

export const languagesSchema = z.object({
  languages: z
    .array(
      z.object({
        code: z.string().trim().length(2).toLowerCase(),
        proficiency: z.enum(['NATIVE', 'FLUENT', 'PROFESSIONAL', 'BASIC']),
      }),
    )
    .max(20),
})

export const acceptNdaSchema = z.object({
  accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the NDA to take on projects' }),
  }),
})

export const workHistorySchema = z
  .object({
    company: z.string().trim().min(1).max(160),
    jobTitle: z.string().trim().min(1).max(160),
    startDate: z.coerce.date(),
    /** Omit for a current role. */
    endDate: z.coerce.date().optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .refine((d) => !d.endDate || d.endDate >= d.startDate, {
    message: 'End date cannot be before the start date',
    path: ['endDate'],
  })

export const testerIdParam = z.object({ id: z.string().cuid() })
export const deviceIdParam = z.object({ deviceId: z.string().cuid() })
export const workHistoryIdParam = z.object({ workHistoryId: z.string().cuid() })

export type ListTestersQuery = z.infer<typeof listTestersQuery>
export type ListGlobalDevicesQuery = z.infer<typeof listGlobalDevicesQuery>

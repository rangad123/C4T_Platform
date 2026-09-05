import { z } from 'zod'
import { TesterStatus, DeviceType } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'
import { ISO_639_1_CODES } from '../../lib/languages.js'
import { ISO_COUNTRY_CODES } from '../../lib/iso-countries.js'

export const TESTER_SORT_FIELDS = [
  'createdAt',
  'ratingAverage',
  'bugsReportedCount',
  'projectsCompletedCount',
  'status',
] as const

export const listTestersQuery = paginationQuery.extend({
  status: z.nativeEnum(TesterStatus).optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .toUpperCase()
    .refine((c) => ISO_COUNTRY_CODES.has(c), 'Not a valid ISO 3166-1 country code')
    .optional(),
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
  /** Free text — `city` is typed by the tester, so there is no code to match on. */
  city: z.string().trim().max(120).optional(),
  /** Matched against a tester's devices AND their browsers' operating systems. */
  osName: z.string().trim().max(60).optional(),
  /** Matched against the browsers a tester has registered under Assets. */
  browser: z.string().trim().max(80).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(TESTER_SORT_FIELDS).optional(),
})

/**
 * A short profile string that the tester is allowed to clear.
 *
 * `.optional()` alone cannot express "set this back to empty" — an omitted
 * key and a cleared field are indistinguishable once the body is parsed. So
 * these accept `''` and the service maps it to null, which is what makes a
 * blank input in the portal actually erase the stored value.
 */
const clearableText = (max: number) => z.string().trim().max(max).optional()

export const updateTesterProfileSchema = z.object({
  headline: clearableText(160),
  bio: clearableText(4000),
  experienceYears: z.coerce.number().int().min(0).max(60).optional(),
  city: clearableText(120),
  /**
   * Two letters, or empty to clear. `.length(2)` rejects `''`, so the union
   * is what allows the field to be blanked at all — the same problem
   * `updateOwnOrganisationSchema` has with its own country code.
   */
  countryCode: z
    .union([
      z
        .string()
        .trim()
        .length(2)
        .toUpperCase()
        .refine((c) => ISO_COUNTRY_CODES.has(c), 'Not a valid ISO 3166-1 country code'),
      z.literal(''),
    ])
    .optional(),
  gender: clearableText(40),
  ageGroup: clearableText(40),
  lookingFor: clearableText(60),
  skype: clearableText(120),
  linkedinUrl: z.union([z.string().trim().url().max(255), z.literal('')]).optional(),
  profession: clearableText(120),
})

/**
 * Attaching the signed NDA document.
 *
 * Separate from `POST /testers/me/nda`, which records the click-through
 * acceptance. A tester may do either, both, or neither, and conflating them
 * would make "accepted online" indistinguishable from "returned a signed
 * copy" — which is exactly the distinction legal cares about.
 */
export const ndaDocumentSchema = z.object({
  fileId: z.string().cuid(),
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
  countryCode: z
    .string()
    .trim()
    .length(2)
    .toUpperCase()
    .refine((c) => ISO_COUNTRY_CODES.has(c), 'Not a valid ISO 3166-1 country code')
    .optional(),
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
        // Picked from the ISO 639-1 list (`GET /catalog`), not typed —
        // rejecting anything outside it here is what actually stops that,
        // the same reasoning as `skillIds` below.
        code: z
          .string()
          .trim()
          .length(2)
          .toLowerCase()
          .refine((code) => ISO_639_1_CODES.has(code), {
            message: 'Not a recognised language code',
          }),
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

/**
 * §44 — the customer-facing crowd browser.
 *
 * Deliberately narrower than `listTestersQuery`: no status filter (only
 * verified testers are discoverable at all) and no free-text name search, so a
 * client cannot use it to confirm whether a specific person is on the
 * platform. See `discoverTesters` for the full reasoning.
 */
export const discoverTestersQuery = paginationQuery.extend({
  search: z.string().trim().max(120).optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .toUpperCase()
    .refine((c) => ISO_COUNTRY_CODES.has(c), 'Not a valid ISO 3166-1 country code')
    .optional(),
  skills: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
    ),
})

/**
 * The assignment picker's read: the same tester filters, plus the build whose
 * roster each result is reported against.
 *
 * `buildId` is required rather than optional. Without it the endpoint would
 * answer a subtly different question — "testers" rather than "testers I could
 * put on this build" — and the caller would have no way to tell an
 * already-invited tester from a fresh one.
 */
export const assignmentCandidatesQuery = listTestersQuery.extend({
  buildId: z.string().cuid(),
})

export type ListTestersQuery = z.infer<typeof listTestersQuery>
export type AssignmentCandidatesQuery = z.infer<typeof assignmentCandidatesQuery>

/**
 * The filter vocabulary shared by the admin tester list and the
 * assignment-candidate picker. Derived from `listTestersQuery` rather than
 * declared separately, so a filter can never exist on one and not the other
 * without the compiler saying so.
 */
export type TesterFilterQuery = Pick<
  ListTestersQuery,
  | 'status'
  | 'countryCode'
  | 'city'
  | 'minRating'
  | 'deviceType'
  | 'languages'
  | 'osName'
  | 'browser'
  | 'skills'
  | 'search'
>
export type ListGlobalDevicesQuery = z.infer<typeof listGlobalDevicesQuery>

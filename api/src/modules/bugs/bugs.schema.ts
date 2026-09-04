import { z } from 'zod'
import { BugSeverity, BugStatus, BugReproducibility, BugType } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'

export const BUG_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'severity',
  'status',
  'reference',
] as const

export const listBugsQuery = paginationQuery.extend({
  projectId: z.string().cuid().optional(),
  buildId: z.string().cuid().optional(),
  /**
   * Comma-separated build ids — the Reports module's "by build range" report
   * scopes to every build between a start and end build, which `buildId`
   * alone (an exact match) cannot express. Independent of `buildId`: a
   * caller sends one or the other, never both.
   */
  buildIds: z
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
  status: z.nativeEnum(BugStatus).optional(),
  severity: z.nativeEnum(BugSeverity).optional(),
  type: z.nativeEnum(BugType).optional(),
  featureId: z.string().cuid().optional(),
  reportedById: z.string().cuid().optional(),
  /**
   * The complement of `reportedById` — every visible bug EXCEPT one
   * reporter's. The tester portal's "Bugs (others)" tab is exactly this
   * list, and expressing it as a filter rather than dropping rows in the
   * client is what keeps its pagination honest: a page of 25 stays a page
   * of 25 instead of shrinking by however many of the tester's own reports
   * happened to land in it.
   *
   * This widens nothing. `bugScope` still decides what the caller may see at
   * all — a tester only reaches another tester's report when the project has
   * `testersCanSeeOtherBugs` enabled.
   */
  excludeReportedById: z.string().cuid().optional(),
  /** Reports "by date" — filters on `createdAt`, inclusive. */
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  search: z.string().trim().max(160).optional(),
  sort: z.enum(BUG_SORT_FIELDS).optional(),
})

/** §2.3 — the fields a Tester fills in when logging a defect. */
/**
 * "It happened 3 times out of 5 attempts."
 *
 * Refined as a pair rather than two loose numbers: an occurrence higher than
 * the attempts it came from is not a bug report, it is a typo, and catching
 * it here means the triager never has to wonder. Both are optional, but
 * supplying one without the other is meaningless, so that is refused too.
 */
const occurrenceFields = {
  occurrence: z.coerce.number().int().min(0).max(10_000).optional(),
  outOf: z.coerce.number().int().min(1).max(10_000).optional(),
}

function refineOccurrence<T extends { occurrence?: number; outOf?: number }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  const hasOccurrence = value.occurrence !== undefined
  const hasOutOf = value.outOf !== undefined

  if (hasOccurrence !== hasOutOf) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasOccurrence ? 'outOf' : 'occurrence'],
      message: 'Give both how many times it happened and how many attempts, or neither',
    })
    return
  }
  if (hasOccurrence && hasOutOf && value.occurrence! > value.outOf!) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['occurrence'],
      message: 'It cannot have happened more times than you tried',
    })
  }
}

export const createBugSchema = z
  .object({
    projectId: z.string().cuid(),
    /** Defaults to the project's default build when omitted. */
    buildId: z.string().cuid().optional(),
    title: z.string().trim().min(5, 'Give the bug a clear one-line title').max(200),
    description: z.string().trim().min(10, 'Describe what is wrong').max(10_000),
    /** The state the app was in before the steps begin. Optional. */
    preCondition: z.string().trim().max(4000).optional(),
    stepsToReproduce: z
      .string()
      .trim()
      .min(5, 'Steps to reproduce are required — another person must be able to follow them')
      .max(10_000),
    expectedResult: z.string().trim().min(5, 'Say what should have happened').max(4000),
    actualResult: z.string().trim().min(5, 'Say what happened instead').max(4000),
    severity: z.nativeEnum(BugSeverity),
    reproducibility: z.nativeEnum(BugReproducibility).default(BugReproducibility.ALWAYS),
    ...occurrenceFields,
    type: z.nativeEnum(BugType).optional(),
    /** Must belong to the same project — checked in the service. */
    featureId: z.string().cuid().optional(),

    /** A link to a recording hosted elsewhere, alongside any uploaded files. */
    videoUrl: z.string().trim().url().max(2000).optional(),

    deviceModel: z.string().trim().max(120).optional(),
    osName: z.string().trim().max(60).optional(),
    osVersion: z.string().trim().max(40).optional(),
    browser: z.string().trim().max(80).optional(),
    appVersion: z.string().trim().max(60).optional(),
    networkType: z.string().trim().max(40).optional(),

    /** Ids of already-uploaded files (see the uploads module). */
    /**
     * Answers to the build's own extra questions (§39). Validated against that
     * build's field definitions in the service — this only bounds the shape.
     */
    customAnswers: z
      .array(z.object({ fieldId: z.string().cuid(), value: z.string().max(4000) }))
      .max(50)
      .optional(),
    attachmentFileIds: z.array(z.string().cuid()).max(20).default([]),
  })
  .superRefine(refineOccurrence)

/** A reporter may correct their own report while it is still untriaged. */
export const updateBugSchema = z
  .object({
    title: z.string().trim().min(5).max(200).optional(),
    description: z.string().trim().min(10).max(10_000).optional(),
    preCondition: z.string().trim().max(4000).optional(),
    stepsToReproduce: z.string().trim().min(5).max(10_000).optional(),
    // Optional to omit from a PATCH (a reporter correcting just the title
    // shouldn't have to retype everything else) — but if included, it cannot
    // be blanked out, for the same reason `createBugSchema` requires it.
    expectedResult: z.string().trim().min(5, 'Say what should have happened').max(4000).optional(),
    actualResult: z.string().trim().min(5, 'Say what happened instead').max(4000).optional(),
    severity: z.nativeEnum(BugSeverity).optional(),
    reproducibility: z.nativeEnum(BugReproducibility).optional(),
    ...occurrenceFields,
    videoUrl: z.union([z.string().trim().url().max(2000), z.literal('')]).optional(),
    type: z.nativeEnum(BugType).nullable().optional(),
    featureId: z.string().cuid().nullable().optional(),
    deviceModel: z.string().trim().max(120).optional(),
    osName: z.string().trim().max(60).optional(),
    osVersion: z.string().trim().max(40).optional(),
    browser: z.string().trim().max(80).optional(),
    appVersion: z.string().trim().max(60).optional(),
    networkType: z.string().trim().max(40).optional(),
  })
  .superRefine(refineOccurrence)

/**
 * Move a bug through its lifecycle.
 *
 * Deliberately not admin-only: a customer marking a defect fixed and an admin
 * confirming one are the same operation. Which transitions each party may make
 * is decided by the matrix in lib/access/policy.ts, not here.
 */
export const changeBugStatusSchema = z
  .object({
    status: z.nativeEnum(BugStatus).optional(),
    /** Admin / project manager only — enforced in the service. */
    severity: z.nativeEnum(BugSeverity).optional(),
    duplicateOfId: z.string().cuid().nullable().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine(
    (d) => d.status !== undefined || d.severity !== undefined || d.duplicateOfId !== undefined,
    {
      message: 'Provide at least one of status, severity or duplicateOfId',
    },
  )
  .refine((d) => d.status !== BugStatus.DUPLICATE || !!d.duplicateOfId, {
    message: 'duplicateOfId is required when marking a bug as a duplicate',
    path: ['duplicateOfId'],
  })
  /**
   * A rejection or a won't-fix ends the conversation for the reporter, so it
   * has to come with a reason. Everything else can stand on its own.
   */
  .refine(
    (d) => {
      const needsNote: BugStatus[] = [BugStatus.REJECTED, BugStatus.WONT_FIX]
      return !d.status || !needsNote.includes(d.status) || !!d.note?.trim()
    },
    {
      message: 'A note is required when rejecting a bug or marking it won’t fix',
      path: ['note'],
    },
  )

export const addCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  /** Internal comments are hidden from Customers and Testers. */
  isInternal: z.boolean().default(false),
})

export const addAttachmentSchema = z.object({
  fileId: z.string().cuid(),
  caption: z.string().trim().max(200).optional(),
})

export const bugIdParam = z.object({ id: z.string().cuid() })
export const bugAttachmentParam = z.object({
  id: z.string().cuid(),
  attachmentId: z.string().cuid(),
})

/**
 * Bulk status change. Same shape as `changeBugStatusSchema` but takes an
 * array of bug ids. The transition matrix is applied per-bug; a bug that
 * can't make the requested transition is skipped rather than aborting the
 * whole batch, so a single misclicked row does not waste the other 49.
 */
export const bulkChangeBugStatusSchema = z.object({
  ids: z.array(z.string().cuid()).min(1).max(200),
  status: z.nativeEnum(BugStatus).optional(),
  severity: z.nativeEnum(BugSeverity).optional(),
  note: z.string().trim().max(2000).optional(),
})

export type ListBugsQuery = z.infer<typeof listBugsQuery>

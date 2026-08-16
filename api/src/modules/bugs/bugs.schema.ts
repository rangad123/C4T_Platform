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
  status: z.nativeEnum(BugStatus).optional(),
  severity: z.nativeEnum(BugSeverity).optional(),
  type: z.nativeEnum(BugType).optional(),
  featureId: z.string().cuid().optional(),
  reportedById: z.string().cuid().optional(),
  search: z.string().trim().max(160).optional(),
  sort: z.enum(BUG_SORT_FIELDS).optional(),
})

/** §2.3 — the fields a Tester fills in when logging a defect. */
export const createBugSchema = z.object({
  projectId: z.string().cuid(),
  title: z.string().trim().min(5, 'Give the bug a clear one-line title').max(200),
  description: z.string().trim().min(10, 'Describe what is wrong').max(10_000),
  stepsToReproduce: z
    .string()
    .trim()
    .min(5, 'Steps to reproduce are required — another person must be able to follow them')
    .max(10_000),
  expectedResult: z.string().trim().max(4000).optional(),
  actualResult: z.string().trim().max(4000).optional(),
  severity: z.nativeEnum(BugSeverity),
  reproducibility: z.nativeEnum(BugReproducibility).default(BugReproducibility.ALWAYS),
  type: z.nativeEnum(BugType).optional(),
  /** Must belong to the same project — checked in the service. */
  featureId: z.string().cuid().optional(),

  deviceModel: z.string().trim().max(120).optional(),
  osName: z.string().trim().max(60).optional(),
  osVersion: z.string().trim().max(40).optional(),
  browser: z.string().trim().max(80).optional(),
  appVersion: z.string().trim().max(60).optional(),
  networkType: z.string().trim().max(40).optional(),

  /** Ids of already-uploaded files (see the uploads module). */
  attachmentFileIds: z.array(z.string().cuid()).max(20).default([]),
})

/** A reporter may correct their own report while it is still untriaged. */
export const updateBugSchema = z.object({
  title: z.string().trim().min(5).max(200).optional(),
  description: z.string().trim().min(10).max(10_000).optional(),
  stepsToReproduce: z.string().trim().min(5).max(10_000).optional(),
  expectedResult: z.string().trim().max(4000).optional(),
  actualResult: z.string().trim().max(4000).optional(),
  severity: z.nativeEnum(BugSeverity).optional(),
  reproducibility: z.nativeEnum(BugReproducibility).optional(),
  type: z.nativeEnum(BugType).nullable().optional(),
  featureId: z.string().cuid().nullable().optional(),
  deviceModel: z.string().trim().max(120).optional(),
  osName: z.string().trim().max(60).optional(),
  osVersion: z.string().trim().max(40).optional(),
  browser: z.string().trim().max(80).optional(),
  appVersion: z.string().trim().max(60).optional(),
  networkType: z.string().trim().max(40).optional(),
})

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

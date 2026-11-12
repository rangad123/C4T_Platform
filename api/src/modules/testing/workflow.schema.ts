import { z } from 'zod'
import { ExecutionReviewStatus, ProjectApplicationStatus, TimesheetStatus } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'

/**
 * Applications, execution reviews and timesheets — the parts of the legacy
 * testing workflow (applied_tests, test_report review, testing_time_sheet)
 * added after test cases. Validated here, decided in workflow.service.ts.
 */

const cuid = z.string().cuid()
const note = z.string().trim().max(2000)

/** Every review queue filters the same way; a tester's own list ignores the scope fields. */
const queueQuery = paginationQuery.extend({
  projectId: cuid.optional(),
  buildId: cuid.optional(),
})

export const idParam = z.object({ id: cuid })
export const buildIdParam = z.object({ buildId: cuid })

// ─── Applications ────────────────────────────────────────────────────────────

export const setApplicationsOpenSchema = z.object({ open: z.boolean() })

export const applySchema = z.object({
  buildId: cuid,
  message: note.optional(),
})

export const listApplicationsQuery = queueQuery.extend({
  status: z.nativeEnum(ProjectApplicationStatus).optional(),
})

export const decideApplicationSchema = z.object({
  decision: z.enum(['ACCEPTED', 'DECLINED']),
  note: note.optional(),
})

// ─── Execution reviews ───────────────────────────────────────────────────────

export const listExecutionsQuery = queueQuery.extend({
  reviewStatus: z.nativeEnum(ExecutionReviewStatus).optional(),
})

/** A rejection says why, so the tester knows what to redo. */
export const reviewExecutionSchema = z
  .object({ decision: z.enum(['APPROVED', 'REJECTED']), note: note.optional() })
  .refine((v) => v.decision === 'APPROVED' || Boolean(v.note), {
    message: 'Say why the execution is rejected',
    path: ['note'],
  })

// ─── Timesheets ──────────────────────────────────────────────────────────────

export const logTimeSchema = z.object({
  buildId: cuid,
  /** A calendar day, `YYYY-MM-DD`. */
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-13'),
  minutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  description: note.optional(),
})

export const listTimesheetsQuery = queueQuery.extend({
  status: z.nativeEnum(TimesheetStatus).optional(),
})

export const reviewTimesheetSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    /** Defaults to the minutes logged; may only cut them, never add. */
    approvedMinutes: z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional(),
    note: note.optional(),
  })
  .refine((v) => v.decision === 'APPROVED' || Boolean(v.note), {
    message: 'Say why the time is rejected',
    path: ['note'],
  })

// ─── Scenarios ───────────────────────────────────────────────────────────────

export const createScenarioSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
})

export type ListApplicationsQuery = z.infer<typeof listApplicationsQuery>
export type ListExecutionsQuery = z.infer<typeof listExecutionsQuery>
export type ListTimesheetsQuery = z.infer<typeof listTimesheetsQuery>

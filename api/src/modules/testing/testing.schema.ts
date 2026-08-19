import { z } from 'zod'
import { TestCaseResult } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'

export const TEST_CASE_SORT_FIELDS = ['createdAt', 'title'] as const

export const listTestCasesQuery = paginationQuery.extend({
  /**
   * Optional so a tester can ask "every case assigned to me" without
   * naming a build up front — the tester portal has no build switcher.
   * Everyone else must supply one; see `listTestCases` in the service.
   */
  buildId: z.string().cuid().optional(),
  search: z.string().trim().max(160).optional(),
  sort: z.enum(TEST_CASE_SORT_FIELDS).optional(),
})

export const createTestCaseSchema = z.object({
  buildId: z.string().cuid(),
  feature: z.string().trim().max(160).optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(5).max(10_000),
  steps: z.string().trim().min(5).max(10_000),
  expectedResult: z.string().trim().min(1).max(4000),
})

export const updateTestCaseSchema = z.object({
  feature: z.string().trim().max(160).nullable().optional(),
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(5).max(10_000).optional(),
  steps: z.string().trim().min(5).max(10_000).optional(),
  expectedResult: z.string().trim().min(1).max(4000).optional(),
})

export const assignTestCaseSchema = z.object({
  testerIds: z.array(z.string().cuid()).min(1).max(50),
})

/** §2.3 — a tester filing the outcome of running an assigned test case. */
export const createTestReportSchema = z.object({
  result: z.nativeEnum(TestCaseResult),
  notes: z.string().trim().max(4000).optional(),
  devices: z.string().trim().max(200).optional(),
  browsers: z.string().trim().max(200).optional(),
  /** Must be a bug on the same project — checked in the service. */
  linkedBugId: z.string().cuid().optional(),
})

export const createTestReviewSchema = z.object({
  summary: z.string().trim().min(3).max(4000),
  rating: z.coerce.number().int().min(1).max(5).optional(),
})

export const testCaseIdParam = z.object({ id: z.string().cuid() })
export const testCaseAssignmentParam = z.object({
  id: z.string().cuid(),
  testerId: z.string().cuid(),
})
export const buildIdParam = z.object({ buildId: z.string().cuid() })

export type ListTestCasesQuery = z.infer<typeof listTestCasesQuery>

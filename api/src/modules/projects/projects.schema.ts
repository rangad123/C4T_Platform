import { z } from 'zod'
import { ProjectStatus, ProjectPriority, AssignmentStatus } from '@prisma/client'
import { paginationQuery } from '../../lib/pagination.js'

export const PROJECT_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'title',
  'status',
  'priority',
  'startDate',
  'endDate',
] as const

export const listProjectsQuery = paginationQuery.extend({
  status: z.nativeEnum(ProjectStatus).optional(),
  priority: z.nativeEnum(ProjectPriority).optional(),
  organisationId: z.string().cuid().optional(),
  search: z.string().trim().max(160).optional(),
  sort: z.enum(PROJECT_SORT_FIELDS).optional(),
})

const isoCountry = z.string().trim().length(2).toUpperCase()
const isoLanguage = z.string().trim().length(2).toLowerCase()

export const createProjectSchema = z
  .object({
    /** Admin must supply this; for a Customer it is inferred from membership. */
    organisationId: z.string().cuid().optional(),
    title: z.string().trim().min(3).max(200),
    summary: z.string().trim().max(2000).optional(),
    instructions: z.string().trim().max(20_000).optional(),
    priority: z.nativeEnum(ProjectPriority).default(ProjectPriority.NORMAL),
    platformTargets: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    targetCountries: z.array(isoCountry).max(60).default([]),
    targetLanguages: z.array(isoLanguage).max(40).default([]),
    maxTesters: z.coerce.number().int().min(1).max(10_000).optional(),
    testersCanSeeOtherBugs: z.boolean().optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  })
  .refine((d) => !d.startDate || !d.endDate || d.endDate >= d.startDate, {
    message: 'End date must be on or after the start date',
    path: ['endDate'],
  })

export const updateProjectSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  summary: z.string().trim().max(2000).optional(),
  instructions: z.string().trim().max(20_000).optional(),
  priority: z.nativeEnum(ProjectPriority).optional(),
  platformTargets: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  targetCountries: z.array(isoCountry).max(60).optional(),
  targetLanguages: z.array(isoLanguage).max(40).optional(),
  maxTesters: z.coerce.number().int().min(1).max(10_000).nullable().optional(),
  testersCanSeeOtherBugs: z.boolean().optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  progressPercent: z.coerce.number().int().min(0).max(100).optional(),
})

export const changeProjectStatusSchema = z.object({
  status: z.nativeEnum(ProjectStatus),
  note: z.string().trim().max(1000).optional(),
})

export const addMaterialSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    fileId: z.string().cuid().optional(),
    url: z.string().trim().url().max(2000).optional(),
  })
  .refine((d) => !!d.fileId || !!d.url, {
    message: 'Provide either an uploaded file or a URL',
    path: ['fileId'],
  })

export const addFeatureSchema = z.object({
  name: z.string().trim().min(1).max(120),
})

export const assignTestersSchema = z.object({
  testerIds: z.array(z.string().cuid()).min(1).max(200),
  notes: z.string().trim().max(1000).optional(),
})

/** Tester responding to an invitation (§2.3). */
export const respondToAssignmentSchema = z.object({
  response: z.enum([AssignmentStatus.ACCEPTED, AssignmentStatus.DECLINED]),
  notes: z.string().trim().max(1000).optional(),
})

export const updateAssignmentSchema = z.object({
  status: z.nativeEnum(AssignmentStatus),
  notes: z.string().trim().max(1000).optional(),
})

export const projectIdParam = z.object({ id: z.string().cuid() })
export const materialParam = z.object({ id: z.string().cuid(), materialId: z.string().cuid() })
export const featureParam = z.object({ id: z.string().cuid(), featureId: z.string().cuid() })
export const assignmentParam = z.object({ id: z.string().cuid(), testerId: z.string().cuid() })

export type ListProjectsQuery = z.infer<typeof listProjectsQuery>

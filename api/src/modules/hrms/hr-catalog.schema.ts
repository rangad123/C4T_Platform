import { z } from 'zod'

/**
 * The four HRMS catalogues share a shape — a name and an `isActive` flag —
 * except for the two that carry one extra field each. Kept as four explicit
 * schemas rather than one generic builder: the differences are real (a leave
 * type has an annual allowance, an investment section has a statutory code),
 * and naming them is shorter than parameterising them.
 */

const name = z.string().trim().min(1, 'A name is required').max(80)

export const catalogKindParam = z.object({
  kind: z.enum([
    'designations',
    'leave-types',
    'incentive-types',
    'investment-sections',
    'crm-industries',
    'crm-lead-sources',
    'crm-communication-statuses',
  ]),
})

export const catalogIdParam = catalogKindParam.extend({ id: z.string().cuid() })

/** The subset of `catalogKindParam` reachable from `/crm/catalog` — see hr-catalog.routes.ts. */
export const crmCatalogKindParam = z.object({
  kind: z.enum(['crm-industries', 'crm-lead-sources', 'crm-communication-statuses']),
})

export const crmCatalogIdParam = crmCatalogKindParam.extend({ id: z.string().cuid() })

export const createDesignationSchema = z.object({ name })
export const createIncentiveTypeSchema = z.object({ name })
export const createCrmIndustrySchema = z.object({ name })
export const createCrmLeadSourceSchema = z.object({ name })
export const createCrmCommunicationStatusSchema = z.object({ name })

export const createLeaveTypeSchema = z.object({
  name,
  /** Days granted per financial year. 0 is meaningful — unpaid leave has none. */
  defaultAnnualDays: z.coerce.number().int().min(0).max(365).default(0),
})

export const createInvestmentSectionSchema = z.object({
  /** The statutory reference, e.g. "80C" or "10(13A)". Unique. */
  code: z.string().trim().min(1, 'A section code is required').max(20),
  name,
})

/**
 * Every field optional: the screen sends only what changed. `isActive` is how
 * a row is retired — there is deliberately no delete, because a designation
 * that employees still reference must not vanish from their records.
 */
export const updateCatalogEntrySchema = z
  .object({
    name: name.optional(),
    code: z.string().trim().min(1).max(20).optional(),
    defaultAnnualDays: z.coerce.number().int().min(0).max(365).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')

export type CatalogKind = z.infer<typeof catalogKindParam>['kind']
export type UpdateCatalogEntryInput = z.infer<typeof updateCatalogEntrySchema>

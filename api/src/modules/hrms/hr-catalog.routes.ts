import { Router } from 'express'
import { Prisma } from '@prisma/client'
import type { ZodTypeAny } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { param } from '../../lib/http.js'
import { validate } from '../../middleware/validate.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import { hrAuthenticate, requireHrRole, HR_ADMIN_ROLES } from './hr-auth.middleware.js'
import { requireCrmAccess, requireCrmCapability } from './hr-crm.middleware.js'
import {
  catalogKindParam,
  catalogIdParam,
  crmCatalogKindParam,
  crmCatalogIdParam,
  createDesignationSchema,
  createLeaveTypeSchema,
  createIncentiveTypeSchema,
  createInvestmentSectionSchema,
  createCrmIndustrySchema,
  createCrmLeadSourceSchema,
  updateCatalogEntrySchema,
  type CatalogKind,
  type UpdateCatalogEntryInput,
} from './hr-catalog.schema.js'

/**
 * Read-only reference data for the four fixed HRMS lists — mirrors the
 * platform's own Catalog pattern (admin-writes/everyone-reads, `isActive`
 * soft-retire) but as its own tables, since an HR request has no platform
 * session to call `GET /v1/catalog` with.
 *
 * The reads below are open to any signed-in employee, because every form's
 * dropdowns need them. ADMIN-gated management routes are at the foot of this
 * file — added when the defects sheet asked for a way to add a designation
 * without a developer running the seed script.
 */
export const hrCatalogRouter = Router()

hrCatalogRouter.use(hrAuthenticate)

hrCatalogRouter.get('/designations', async (_req, res) => {
  const rows = await prisma.hrDesignation.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/leave-types', async (_req, res) => {
  const rows = await prisma.hrLeaveType.findMany({
    where: { isActive: true },
    select: { id: true, name: true, defaultAnnualDays: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/incentive-types', async (_req, res) => {
  const rows = await prisma.hrIncentiveType.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/investment-sections', async (_req, res) => {
  const rows = await prisma.hrInvestmentSection.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/crm-industries', async (_req, res) => {
  const rows = await prisma.crmIndustry.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

hrCatalogRouter.get('/crm-lead-sources', async (_req, res) => {
  const rows = await prisma.crmLeadSource.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json({ data: rows })
})

// ── Admin management ─────────────────────────────────────────────────────────
//
// The reads above stay exactly as they were: active rows only, for the
// dropdowns every form renders. These are for the Catalogues screen, which
// needs to see retired rows in order to bring one back.
//
// There is no delete. A designation or leave type is referenced by employee
// records and leave requests, so removing one would either fail on a foreign
// key or orphan history; `isActive` retires it from the pickers while leaving
// what already points at it intact — the same soft-retire the platform's own
// catalog uses.

/**
 * The four delegates share these three calls. Typed structurally and called as
 * members (never pulled off into a variable) so `this` stays bound to the
 * Prisma delegate.
 */
interface CatalogDelegate {
  findMany(args: unknown): Promise<unknown>
  create(args: unknown): Promise<{ id: string }>
  update(args: unknown): Promise<{ id: string }>
}

/** The six tables behind the six kinds, so a handler can pick one by name. */
function delegateFor(kind: CatalogKind): CatalogDelegate {
  switch (kind) {
    case 'designations':
      return prisma.hrDesignation
    case 'leave-types':
      return prisma.hrLeaveType
    case 'incentive-types':
      return prisma.hrIncentiveType
    case 'investment-sections':
      return prisma.hrInvestmentSection
    case 'crm-industries':
      return prisma.crmIndustry
    case 'crm-lead-sources':
      return prisma.crmLeadSource
  }
}

const CREATE_SCHEMAS: Record<CatalogKind, ZodTypeAny> = {
  designations: createDesignationSchema,
  'leave-types': createLeaveTypeSchema,
  'incentive-types': createIncentiveTypeSchema,
  'investment-sections': createInvestmentSectionSchema,
  'crm-industries': createCrmIndustrySchema,
  'crm-lead-sources': createCrmLeadSourceSchema,
}

/**
 * The three handlers below are shared by two route families that differ only
 * in who may call them: `/admin/:kind` (any of the six kinds, gated to an HR
 * administrator) and `/crm/:kind` (only the two `crm-*` kinds, gated to
 * whoever holds the CRM `manage_catalog` capability — which, per `CrmRole`,
 * is not necessarily an HR administrator at all).
 */
async function listCatalogEntries(kind: CatalogKind) {
  return delegateFor(kind).findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] })
}

async function createCatalogEntry(
  req: Parameters<typeof recordHrAudit>[0]['req'],
  kind: CatalogKind,
  body: unknown,
): Promise<{ id: string }> {
  const parsed = CREATE_SCHEMAS[kind].safeParse(body)
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid catalogue entry')
  }

  let row: { id: string }
  try {
    row = await delegateFor(kind).create({ data: parsed.data })
  } catch (error) {
    // Every one of these tables has a unique key (name, or code) — report the
    // clash rather than letting a raw constraint error surface.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('That entry already exists')
    }
    throw error
  }

  await recordHrAudit({
    req,
    action: 'hr.catalog.created',
    entityType: kind,
    entityId: row.id,
    after: parsed.data as Record<string, unknown>,
  })
  return row
}

async function updateCatalogEntry(
  req: Parameters<typeof recordHrAudit>[0]['req'],
  kind: CatalogKind,
  id: string,
  input: UpdateCatalogEntryInput,
): Promise<{ id: string }> {
  // Only fields that exist on the chosen table — sending defaultAnnualDays to
  // a designation would be a Prisma error rather than a validation one.
  const data: Record<string, unknown> = {}
  if (input.name !== undefined) data.name = input.name
  if (input.isActive !== undefined) data.isActive = input.isActive
  if (input.code !== undefined && kind === 'investment-sections') data.code = input.code
  if (input.defaultAnnualDays !== undefined && kind === 'leave-types') {
    data.defaultAnnualDays = input.defaultAnnualDays
  }
  if (Object.keys(data).length === 0) {
    throw new BadRequestError('Nothing on this entry can be changed by those fields')
  }

  try {
    const row = await delegateFor(kind).update({ where: { id }, data })
    await recordHrAudit({
      req,
      action: 'hr.catalog.updated',
      entityType: kind,
      entityId: id,
      after: data,
    })
    return row
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ConflictError('That entry already exists')
      if (error.code === 'P2025') throw new NotFoundError('Catalogue entry')
    }
    throw error
  }
}

hrCatalogRouter.get(
  '/admin/:kind',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ params: catalogKindParam }),
  async (req, res) => {
    res.json({ data: await listCatalogEntries(param(req, 'kind') as CatalogKind) })
  },
)

hrCatalogRouter.post(
  '/admin/:kind',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ params: catalogKindParam }),
  async (req, res) => {
    const row = await createCatalogEntry(req, param(req, 'kind') as CatalogKind, req.body)
    res.status(201).json({ data: row })
  },
)

hrCatalogRouter.patch(
  '/admin/:kind/:id',
  requireHrRole(...HR_ADMIN_ROLES),
  validate({ params: catalogIdParam, body: updateCatalogEntrySchema }),
  async (req, res) => {
    const row = await updateCatalogEntry(
      req,
      param(req, 'kind') as CatalogKind,
      param(req, 'id'),
      req.body as UpdateCatalogEntryInput,
    )
    res.json({ data: row })
  },
)

// ── CRM catalog management ───────────────────────────────────────────────────
//
// Same three handlers as above, restricted by `crmCatalogKindParam` to just
// `crm-industries`/`crm-lead-sources` and gated by CRM's own `manage_catalog`
// capability rather than `HrRole` — a CRM Administrator who is an ordinary
// HR `EMPLOYEE` reaches these from `/crm/catalog`; an HR administrator can
// still manage the same two tables from `/admin/catalogues` above.

hrCatalogRouter.get(
  '/crm/:kind',
  requireCrmAccess,
  requireCrmCapability('manage_catalog'),
  validate({ params: crmCatalogKindParam }),
  async (req, res) => {
    res.json({ data: await listCatalogEntries(param(req, 'kind') as CatalogKind) })
  },
)

hrCatalogRouter.post(
  '/crm/:kind',
  requireCrmAccess,
  requireCrmCapability('manage_catalog'),
  validate({ params: crmCatalogKindParam }),
  async (req, res) => {
    const row = await createCatalogEntry(req, param(req, 'kind') as CatalogKind, req.body)
    res.status(201).json({ data: row })
  },
)

hrCatalogRouter.patch(
  '/crm/:kind/:id',
  requireCrmAccess,
  requireCrmCapability('manage_catalog'),
  validate({ params: crmCatalogIdParam, body: updateCatalogEntrySchema }),
  async (req, res) => {
    const row = await updateCatalogEntry(
      req,
      param(req, 'kind') as CatalogKind,
      param(req, 'id'),
      req.body as UpdateCatalogEntryInput,
    )
    res.json({ data: row })
  },
)

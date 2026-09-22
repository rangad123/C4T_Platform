import { type Prisma, CrmLeadStatus, CrmActivityKind } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { searchTerms } from '../../lib/search.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { crmCapabilityScope, type CrmRole } from '../../lib/hrms/hr-crm-capabilities.js'
import {
  LEAD_SORT_FIELDS,
  type CreateLeadInput,
  type UpdateLeadInput,
  type ListLeadsQuery,
  type CreateContactInput,
  type UpdateContactInput,
} from './hr-crm-leads.schema.js'

/** The CRM employee making the call, and the tier that decides their scope. */
export interface CrmActor {
  id: string
  role: CrmRole
}

const employeeSummary = {
  select: { id: true, firstName: true, lastName: true, employeeCode: true },
} satisfies { select: Prisma.HrEmployeeSelect }

const listSelect = {
  id: true,
  companyName: true,
  status: true,
  countryCode: true,
  location: true,
  industry: { select: { id: true, name: true } },
  leadSource: { select: { id: true, name: true } },
  assignedTo: employeeSummary,
  createdAt: true,
  updatedAt: true,
  lastActivityAt: true,
} satisfies Prisma.CrmLeadSelect

const detailSelect = {
  ...listSelect,
  companySize: true,
  website: true,
  registeredOrgName: true,
  registeredAddress: true,
  gstin: true,
  createdBy: employeeSummary,
  contacts: { orderBy: { createdAt: 'asc' } },
  activity: {
    orderBy: { createdAt: 'desc' },
    include: { employee: employeeSummary },
  },
} satisfies Prisma.CrmLeadSelect

/**
 * Bakes ownership scoping directly into the query's own `WHERE` rather than
 * loading a row and checking it afterwards — an EMPLOYEE-tier request for a
 * lead assigned to someone else simply matches nothing and surfaces as a
 * plain 404, the same "the query itself is the security boundary" shape
 * `hrSelfRouter` already uses for an employee's own record.
 */
function ownershipWhere(actor: CrmActor, capability: Parameters<typeof crmCapabilityScope>[1]) {
  const scope = crmCapabilityScope(actor.role, capability)
  return scope === 'own' ? { assignedToId: actor.id } : {}
}

async function touchLastActivity(leadId: string, at: Date, tx: Prisma.TransactionClient) {
  await tx.crmLead.update({ where: { id: leadId }, data: { lastActivityAt: at } })
}

export async function listLeads(actor: CrmActor, query: ListLeadsQuery) {
  const where: Prisma.CrmLeadWhereInput = {
    deletedAt: null,
    ...ownershipWhere(actor, 'view_leads'),
    ...(query.status && query.status.length > 0 ? { status: { in: query.status } } : {}),
    ...(query.industryId ? { industryId: query.industryId } : {}),
    ...(query.leadSourceId ? { leadSourceId: query.leadSourceId } : {}),
    ...(query.countryCode ? { countryCode: query.countryCode } : {}),
    ...(query.assignedToId
      ? query.assignedToId === 'unassigned'
        ? { assignedToId: null }
        : { assignedToId: query.assignedToId }
      : {}),
    ...(query.createdFrom || query.createdTo
      ? { createdAt: { gte: query.createdFrom, lte: query.createdTo } }
      : {}),
    ...(query.updatedFrom || query.updatedTo
      ? { updatedAt: { gte: query.updatedFrom, lte: query.updatedTo } }
      : {}),
    ...(query.lastActivityFrom || query.lastActivityTo
      ? { lastActivityAt: { gte: query.lastActivityFrom, lte: query.lastActivityTo } }
      : {}),
    ...(searchTerms(query.search).length > 0
      ? {
          AND: searchTerms(query.search).map((term) => ({
            OR: [
              { companyName: { contains: term, mode: 'insensitive' as const } },
              { registeredOrgName: { contains: term, mode: 'insensitive' as const } },
              { gstin: { contains: term, mode: 'insensitive' as const } },
              {
                contacts: {
                  some: {
                    OR: [
                      { name: { contains: term, mode: 'insensitive' as const } },
                      { email: { contains: term, mode: 'insensitive' as const } },
                    ],
                  },
                },
              },
            ],
          })),
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.crmLead.findMany({
      where,
      select: listSelect,
      orderBy: buildOrderBy(query.sort, query.order, LEAD_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.crmLead.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

export async function getLead(actor: CrmActor, id: string) {
  const lead = await prisma.crmLead.findFirst({
    where: { id, deletedAt: null, ...ownershipWhere(actor, 'view_leads') },
    select: detailSelect,
  })
  if (!lead) throw new NotFoundError('Lead')
  return lead
}

export async function createLead(actor: CrmActor, input: CreateLeadInput) {
  const scope = crmCapabilityScope(actor.role, 'create_leads')
  // An 'own'-scoped tier (EMPLOYEE) cannot hand a new lead to anyone else —
  // it lands on them, full stop, regardless of what the form posted.
  const assignedToId = scope === 'own' ? actor.id : (input.assignedToId ?? null)

  const now = new Date()
  return prisma.$transaction(async (tx) => {
    const created = await tx.crmLead.create({
      data: {
        companyName: input.companyName,
        companySize: input.companySize,
        website: input.website,
        industryId: input.industryId,
        leadSourceId: input.leadSourceId,
        countryCode: input.countryCode,
        location: input.location,
        registeredOrgName: input.registeredOrgName,
        registeredAddress: input.registeredAddress,
        gstin: input.gstin,
        status: CrmLeadStatus.NEW,
        assignedToId,
        createdById: actor.id,
        lastActivityAt: now,
      },
      select: { id: true },
    })
    await tx.crmLeadActivity.create({
      data: {
        leadId: created.id,
        employeeId: actor.id,
        kind: CrmActivityKind.CREATED,
        createdAt: now,
      },
    })
    // Selected after the activity insert, in the same transaction, so the
    // returned `activity` relation includes the row just written above —
    // selecting it as part of the `create` above would return it stale.
    return tx.crmLead.findUniqueOrThrow({ where: { id: created.id }, select: detailSelect })
  })
}

export async function updateLead(actor: CrmActor, id: string, input: UpdateLeadInput) {
  const existing = await prisma.crmLead.findFirst({
    where: { id, deletedAt: null, ...ownershipWhere(actor, 'edit_leads') },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Lead')

  return prisma.crmLead.update({ where: { id }, data: input, select: detailSelect })
}

export async function changeLeadStatus(actor: CrmActor, id: string, status: CrmLeadStatus) {
  const existing = await prisma.crmLead.findFirst({
    where: { id, deletedAt: null, ...ownershipWhere(actor, 'change_status') },
    select: { id: true, status: true },
  })
  if (!existing) throw new NotFoundError('Lead')
  if (existing.status === status) {
    return prisma.crmLead.findUniqueOrThrow({ where: { id }, select: detailSelect })
  }

  const now = new Date()
  return prisma.$transaction(async (tx) => {
    await tx.crmLead.update({
      where: { id },
      data: { status, lastActivityAt: now },
      select: { id: true },
    })
    await tx.crmLeadActivity.create({
      data: {
        leadId: id,
        employeeId: actor.id,
        kind: CrmActivityKind.STATUS_CHANGED,
        meta: { from: existing.status, to: status },
        createdAt: now,
      },
    })
    // See the matching comment in `createLead` — select after the activity
    // insert so `activity` reflects it.
    return tx.crmLead.findUniqueOrThrow({ where: { id }, select: detailSelect })
  })
}

/** No ownership scoping: `assign_leads` has no 'own' entry in the matrix — a tier either has it org-wide or not at all. */
export async function assignLead(actor: CrmActor, id: string, assignedToId: string | null) {
  const existing = await prisma.crmLead.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, assignedToId: true },
  })
  if (!existing) throw new NotFoundError('Lead')
  if (existing.assignedToId === assignedToId) {
    return prisma.crmLead.findUniqueOrThrow({ where: { id }, select: detailSelect })
  }

  const now = new Date()
  return prisma.$transaction(async (tx) => {
    await tx.crmLead.update({
      where: { id },
      data: { assignedToId, lastActivityAt: now },
      select: { id: true },
    })
    await tx.crmLeadActivity.create({
      data: {
        leadId: id,
        employeeId: actor.id,
        kind: CrmActivityKind.ASSIGNED,
        meta: { from: existing.assignedToId, to: assignedToId },
        createdAt: now,
      },
    })
    // See the matching comment in `createLead` — select after the activity
    // insert so `activity` reflects it.
    return tx.crmLead.findUniqueOrThrow({ where: { id }, select: detailSelect })
  })
}

/** No ownership scoping — same reasoning as `assignLead`: `delete_leads` is ADMIN-only, never 'own'. */
export async function archiveLead(id: string) {
  const existing = await prisma.crmLead.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Lead')
  await prisma.crmLead.update({ where: { id }, data: { deletedAt: new Date() } })
}

export async function addLeadNote(actor: CrmActor, id: string, body: string) {
  const existing = await prisma.crmLead.findFirst({
    where: { id, deletedAt: null, ...ownershipWhere(actor, 'add_activity') },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Lead')

  const now = new Date()
  return prisma.$transaction(async (tx) => {
    const activity = await tx.crmLeadActivity.create({
      data: { leadId: id, employeeId: actor.id, kind: CrmActivityKind.NOTE, body, createdAt: now },
      include: { employee: employeeSummary },
    })
    await touchLastActivity(id, now, tx)
    return activity
  })
}

export async function addLeadContact(actor: CrmActor, id: string, input: CreateContactInput) {
  const existing = await prisma.crmLead.findFirst({
    where: { id, deletedAt: null, ...ownershipWhere(actor, 'manage_contacts') },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Lead')

  return prisma.crmContact.create({ data: { leadId: id, ...input } })
}

export async function updateLeadContact(
  actor: CrmActor,
  id: string,
  contactId: string,
  input: UpdateContactInput,
) {
  const existing = await prisma.crmContact.findFirst({
    where: {
      id: contactId,
      leadId: id,
      lead: { deletedAt: null, ...ownershipWhere(actor, 'manage_contacts') },
    },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Contact')

  return prisma.crmContact.update({ where: { id: contactId }, data: input })
}

export async function removeLeadContact(actor: CrmActor, id: string, contactId: string) {
  const existing = await prisma.crmContact.findFirst({
    where: {
      id: contactId,
      leadId: id,
      lead: { deletedAt: null, ...ownershipWhere(actor, 'manage_contacts') },
    },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Contact')

  await prisma.crmContact.delete({ where: { id: contactId } })
}

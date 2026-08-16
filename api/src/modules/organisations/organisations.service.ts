import { type Prisma, OrganisationStatus, OrgMemberRole, Role } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { isAdminSide } from '../../middleware/authorize.js'
import { organisationScope } from '../../lib/access/scopes.js'
import { ORG_SORT_FIELDS, type ListOrganisationsQuery } from './organisations.schema.js'

const orgSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  website: true,
  industry: true,
  contactEmail: true,
  contactPhone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  countryCode: true,
  taxId: true,
  logoFileId: true,
  onboardedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganisationSelect

/**
 * Resolves whether a caller may touch an organisation.
 * Admin-side roles see everything; a Customer sees only organisations they
 * belong to. Returns the caller's org role when they are a member.
 */
export async function assertOrgAccess(
  user: Express.AuthenticatedUser,
  organisationId: string,
  options: { requireOwner?: boolean } = {},
): Promise<{ orgRole: OrgMemberRole | null }> {
  if (isAdminSide(user)) return { orgRole: null }

  const membership = await prisma.organisationMember.findUnique({
    where: { organisationId_userId: { organisationId, userId: user.id } },
    select: { orgRole: true },
  })

  if (!membership) throw new NotFoundError('Organisation')
  if (options.requireOwner && membership.orgRole !== OrgMemberRole.OWNER) {
    throw new ForbiddenError('Only an organisation owner can make this change')
  }
  return { orgRole: membership.orgRole }
}

/**
 * Scoped by the caller, exactly like projects and bugs: an admin sees every
 * organisation, a customer sees the ones they belong to, everyone else sees
 * none.
 *
 * This used to be admin-only, which meant a customer could open their own
 * organisation by id but never see it in a list — caught by the list/detail
 * invariant in tests/access/consistency.test.ts.
 */
export async function listOrganisations(
  user: Express.AuthenticatedUser,
  query: ListOrganisationsQuery,
) {
  const where: Prisma.OrganisationWhereInput = {
    deletedAt: null,
    ...organisationScope(user),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { contactEmail: { contains: query.search, mode: 'insensitive' } },
            { slug: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.organisation.findMany({
      where,
      select: {
        ...orgSelect,
        _count: { select: { members: true, projects: true } },
      },
      orderBy: buildOrderBy(query.sort, query.order, ORG_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.organisation.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

/**
 * CSV export of the same row set the list endpoint returns, minus pagination.
 * Reuses the exact `where` clause from `listOrganisations` so the access scope
 * and filters are identical — exporting never bypasses RBAC.
 */
export async function exportOrganisationsCSV(
  user: Express.AuthenticatedUser,
  query: ListOrganisationsQuery,
): Promise<string> {
  const where: Prisma.OrganisationWhereInput = {
    deletedAt: null,
    ...organisationScope(user),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { contactEmail: { contains: query.search, mode: 'insensitive' } },
            { slug: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const items = await prisma.organisation.findMany({
    where,
    select: {
      ...orgSelect,
      _count: { select: { members: true, projects: true } },
    },
    orderBy: buildOrderBy(query.sort, query.order, ORG_SORT_FIELDS, 'createdAt'),
  })

  const rows = items.map((o) => [
    o.name,
    o.slug,
    o.status,
    o.industry ?? '',
    o.contactEmail ?? '',
    o.contactPhone ?? '',
    o.city ?? '',
    o.countryCode ?? '',
    o._count.members,
    o._count.projects,
    o.onboardedAt,
    o.createdAt,
    o.updatedAt,
  ])

  const { toCsv } = await import('../../lib/csv.js')
  return toCsv(
    [
      'Name',
      'Slug',
      'Status',
      'Industry',
      'Contact email',
      'Contact phone',
      'City',
      'Country',
      'Members',
      'Projects',
      'Onboarded at',
      'Created at',
      'Updated at',
    ],
    rows,
  )
}

/** Organisations the calling Customer belongs to (§2.4). */
export async function listMyOrganisations(userId: string) {
  const memberships = await prisma.organisationMember.findMany({
    where: { userId, organisation: { deletedAt: null } },
    select: { orgRole: true, organisation: { select: orgSelect } },
    orderBy: { createdAt: 'asc' },
  })
  return memberships.map((m) => ({ ...m.organisation, orgRole: m.orgRole }))
}

export async function getOrganisation(user: Express.AuthenticatedUser, id: string) {
  await assertOrgAccess(user, id)

  const org = await prisma.organisation.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...orgSelect,
      notes: isAdminSide(user),
      members: {
        select: {
          orgRole: true,
          joinedAt: true,
          user: {
            select: { id: true, email: true, firstName: true, lastName: true, status: true },
          },
        },
      },
      _count: { select: { projects: true, transactions: true } },
    },
  })

  if (!org) throw new NotFoundError('Organisation')
  return org
}

async function uniqueSlug(name: string, tx: Prisma.TransactionClient): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'org'
  let slug = base
  for (
    let i = 2;
    await tx.organisation.findUnique({ where: { slug }, select: { id: true } });
    i++
  ) {
    slug = `${base}-${i}`
  }
  return slug
}

export async function createOrganisation(input: {
  name: string
  status: OrganisationStatus
  ownerUserId?: string
  notes?: string
  [key: string]: unknown
}) {
  const { ownerUserId, name, status, ...rest } = input

  return prisma.$transaction(async (tx) => {
    if (ownerUserId) {
      const owner = await tx.user.findUnique({
        where: { id: ownerUserId },
        select: { id: true, role: true },
      })
      if (!owner) throw new BadRequestError('Owner user does not exist')
      // Promote a plain USER into a CUSTOMER when they are attached to an org.
      if (owner.role === Role.USER) {
        await tx.user.update({ where: { id: owner.id }, data: { role: Role.CUSTOMER } })
      }
    }

    const org = await tx.organisation.create({
      data: {
        // Profile fields first, so the authoritative name/slug/status below can
        // never be clobbered by a stray key in the request body.
        ...(rest as Omit<Prisma.OrganisationCreateInput, 'name' | 'slug' | 'status'>),
        name,
        status,
        slug: await uniqueSlug(name, tx),
        ...(status === OrganisationStatus.ACTIVE ? { onboardedAt: new Date() } : {}),
        ...(ownerUserId
          ? {
              members: {
                create: { userId: ownerUserId, orgRole: OrgMemberRole.OWNER, joinedAt: new Date() },
              },
            }
          : {}),
      },
      select: orgSelect,
    })

    return org
  })
}

export async function updateOrganisation(
  user: Express.AuthenticatedUser,
  id: string,
  input: Record<string, unknown>,
) {
  // A Customer may edit only their own organisation, and only as OWNER.
  await assertOrgAccess(user, id, { requireOwner: !isAdminSide(user) })

  const existing = await prisma.organisation.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, status: true, onboardedAt: true },
  })
  if (!existing) throw new NotFoundError('Organisation')

  const becomingActive =
    input.status === OrganisationStatus.ACTIVE && existing.status !== OrganisationStatus.ACTIVE

  return prisma.organisation.update({
    where: { id },
    data: {
      ...(input as Prisma.OrganisationUpdateInput),
      ...(becomingActive && !existing.onboardedAt ? { onboardedAt: new Date() } : {}),
    },
    select: orgSelect,
  })
}

/** Soft delete. Refuses while active projects still reference the org. */
export async function archiveOrganisation(id: string) {
  const activeProjects = await prisma.project.count({
    where: {
      organisationId: id,
      deletedAt: null,
      status: { in: ['SUBMITTED', 'APPROVED', 'IN_PROGRESS', 'PAUSED'] },
    },
  })
  if (activeProjects > 0) {
    throw new ConflictError(
      `This organisation has ${activeProjects} active project(s). Close or cancel them before archiving.`,
    )
  }

  return prisma.organisation.update({
    where: { id },
    data: { deletedAt: new Date(), status: OrganisationStatus.ARCHIVED },
    select: { id: true, status: true, deletedAt: true },
  })
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function addMember(
  user: Express.AuthenticatedUser,
  organisationId: string,
  input: { userId: string; orgRole: OrgMemberRole },
) {
  await assertOrgAccess(user, organisationId, { requireOwner: !isAdminSide(user) })

  const target = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, role: true, deletedAt: true },
  })
  if (!target || target.deletedAt) throw new BadRequestError('User does not exist')
  if (target.role === Role.TESTER) {
    throw new BadRequestError('A tester account cannot be added to a customer organisation')
  }

  const existing = await prisma.organisationMember.findUnique({
    where: { organisationId_userId: { organisationId, userId: input.userId } },
    select: { id: true },
  })
  if (existing) throw new ConflictError('That user is already a member of this organisation')

  return prisma.$transaction(async (tx) => {
    if (target.role === Role.USER) {
      await tx.user.update({ where: { id: target.id }, data: { role: Role.CUSTOMER } })
    }
    return tx.organisationMember.create({
      data: { organisationId, userId: input.userId, orgRole: input.orgRole, joinedAt: new Date() },
      select: {
        orgRole: true,
        joinedAt: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    })
  })
}

export async function updateMember(
  user: Express.AuthenticatedUser,
  organisationId: string,
  userId: string,
  orgRole: OrgMemberRole,
) {
  await assertOrgAccess(user, organisationId, { requireOwner: !isAdminSide(user) })
  await assertNotLastOwner(organisationId, userId, orgRole)

  return prisma.organisationMember.update({
    where: { organisationId_userId: { organisationId, userId } },
    data: { orgRole },
    select: { orgRole: true, user: { select: { id: true, email: true } } },
  })
}

export async function removeMember(
  user: Express.AuthenticatedUser,
  organisationId: string,
  userId: string,
) {
  await assertOrgAccess(user, organisationId, { requireOwner: !isAdminSide(user) })
  await assertNotLastOwner(organisationId, userId, OrgMemberRole.MEMBER)

  await prisma.organisationMember.delete({
    where: { organisationId_userId: { organisationId, userId } },
  })
}

/** An organisation must always retain at least one OWNER. */
async function assertNotLastOwner(
  organisationId: string,
  userId: string,
  nextRole: OrgMemberRole,
): Promise<void> {
  if (nextRole === OrgMemberRole.OWNER) return

  const current = await prisma.organisationMember.findUnique({
    where: { organisationId_userId: { organisationId, userId } },
    select: { orgRole: true },
  })
  if (!current) throw new NotFoundError('Organisation member')
  if (current.orgRole !== OrgMemberRole.OWNER) return

  const ownerCount = await prisma.organisationMember.count({
    where: { organisationId, orgRole: OrgMemberRole.OWNER },
  })
  if (ownerCount <= 1) {
    throw new ConflictError('An organisation must have at least one owner')
  }
}

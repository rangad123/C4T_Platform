import { type Prisma, OrganisationStatus, OrgMemberRole, Role } from '@prisma/client'
import { generateOpaqueToken, hashToken } from '../../lib/tokens.js'
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

// ─── Team invitations (§40-43) ───────────────────────────────────────────────

/**
 * Trims a note and turns an empty one into null.
 *
 * Written out rather than `x?.trim() || null` because `??` — which the lint
 * rule prefers — would keep an empty string, and "the inviter wrote nothing"
 * should be null in the column, not "".
 */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed
}

/** Fourteen days. Long enough to survive a holiday, short enough to expire. */
const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000

const invitationSelect = {
  id: true,
  email: true,
  orgRole: true,
  message: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.OrganisationInvitationSelect

/** Open = not accepted, not revoked, not expired. */
function invitationState(row: {
  acceptedAt: Date | null
  revokedAt: Date | null
  expiresAt: Date
}): 'ACCEPTED' | 'REVOKED' | 'EXPIRED' | 'PENDING' {
  if (row.acceptedAt) return 'ACCEPTED'
  if (row.revokedAt) return 'REVOKED'
  if (row.expiresAt.getTime() < Date.now()) return 'EXPIRED'
  return 'PENDING'
}

export async function listInvitations(user: Express.AuthenticatedUser, organisationId: string) {
  await assertOrgAccess(user, organisationId)
  const rows = await prisma.organisationInvitation.findMany({
    where: { organisationId },
    select: invitationSelect,
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((row) => ({ ...row, state: invitationState(row) }))
}

/**
 * §42 — invite someone to the team by email address.
 *
 * Owner-only, like every other membership change here. Re-inviting an address
 * that already has an open invitation refreshes it (new token, new expiry,
 * new note) rather than stacking duplicates — which is also why the unique
 * constraint is on `[organisationId, email]`.
 *
 * The raw token is returned to the CALLER, never stored: only its hash goes to
 * the database, exactly as password-reset tokens work. The caller's only use
 * for it is putting it in the email.
 */
export async function inviteMember(
  user: Express.AuthenticatedUser,
  organisationId: string,
  input: { email: string; orgRole?: OrgMemberRole; message?: string },
) {
  await assertOrgAccess(user, organisationId, { requireOwner: !isAdminSide(user) })

  const email = input.email.trim().toLowerCase()

  /**
   * Someone already on the team does not need an invitation. Checked by
   * email against the user table rather than by membership alone, because the
   * person may have an account under that address without being a member yet.
   */
  const existingUser = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true },
  })
  if (existingUser) {
    const alreadyMember = await prisma.organisationMember.findUnique({
      where: { organisationId_userId: { organisationId, userId: existingUser.id } },
      select: { id: true },
    })
    if (alreadyMember) throw new ConflictError('That person is already on your team')
  }

  const { raw, hash } = generateOpaqueToken()
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)

  const invitation = await prisma.organisationInvitation.upsert({
    where: { organisationId_email: { organisationId, email } },
    create: {
      organisationId,
      email,
      orgRole: input.orgRole ?? OrgMemberRole.MEMBER,
      message: blankToNull(input.message),
      tokenHash: hash,
      invitedById: user.id,
      expiresAt,
    },
    update: {
      orgRole: input.orgRole ?? OrgMemberRole.MEMBER,
      message: blankToNull(input.message),
      tokenHash: hash,
      invitedById: user.id,
      expiresAt,
      // Re-inviting revives a revoked or expired row rather than leaving it
      // dead alongside a new one.
      acceptedAt: null,
      revokedAt: null,
    },
    select: invitationSelect,
  })

  /**
   * The organisation and inviter names come back with the token because the
   * caller needs them for the email and has no other cheap way to get them —
   * `AuthenticatedUser` carries an id and a role, not a display name.
   */
  const [organisation, inviter] = await Promise.all([
    prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { name: true },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { firstName: true, lastName: true },
    }),
  ])

  return {
    invitation: { ...invitation, state: invitationState(invitation) },
    token: raw,
    organisationName: organisation?.name ?? 'your team',
    invitedByName:
      [inviter?.firstName, inviter?.lastName].filter(Boolean).join(' ') || 'A teammate',
  }
}

export async function revokeInvitation(
  user: Express.AuthenticatedUser,
  organisationId: string,
  invitationId: string,
) {
  await assertOrgAccess(user, organisationId, { requireOwner: !isAdminSide(user) })

  const row = await prisma.organisationInvitation.findFirst({
    where: { id: invitationId, organisationId },
    select: { id: true, acceptedAt: true },
  })
  if (!row) throw new NotFoundError('Invitation')
  if (row.acceptedAt) throw new ConflictError('That invitation has already been accepted')

  const updated = await prisma.organisationInvitation.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
    select: invitationSelect,
  })
  return { ...updated, state: invitationState(updated) }
}

/**
 * §42 — the invited person accepts.
 *
 * Looked up by token hash, so the raw token in the link is never compared
 * against anything stored. The signed-in account's email must match the one
 * invited: without that check, anyone holding the link could join a team they
 * were never invited to.
 */
export async function acceptInvitation(user: Express.AuthenticatedUser, rawToken: string) {
  const row = await prisma.organisationInvitation.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: {
      id: true,
      organisationId: true,
      email: true,
      orgRole: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      organisation: { select: { id: true, name: true } },
    },
  })
  if (!row) throw new NotFoundError('Invitation')

  const state = invitationState(row)
  if (state === 'ACCEPTED') throw new ConflictError('That invitation has already been used')
  if (state === 'REVOKED') throw new ConflictError('That invitation was withdrawn')
  if (state === 'EXPIRED') throw new ConflictError('That invitation has expired')

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true },
  })
  if (account?.email.toLowerCase() !== row.email.toLowerCase()) {
    throw new ForbiddenError('This invitation was sent to a different email address')
  }

  await prisma.$transaction([
    prisma.organisationMember.upsert({
      where: { organisationId_userId: { organisationId: row.organisationId, userId: user.id } },
      create: {
        organisationId: row.organisationId,
        userId: user.id,
        orgRole: row.orgRole,
        invitedAt: new Date(),
        joinedAt: new Date(),
      },
      update: { joinedAt: new Date() },
    }),
    prisma.organisationInvitation.update({
      where: { id: row.id },
      data: { acceptedAt: new Date() },
    }),
  ])

  return { organisation: row.organisation, orgRole: row.orgRole }
}

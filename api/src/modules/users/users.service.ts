import { type Prisma, Role, UserStatus, TesterStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { searchTerms } from '../../lib/search.js'
import { hashPassword } from '../../lib/password.js'
import { NotFoundError, BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import { PERMISSION_CATALOGUE, DEFAULT_SUBADMIN_PERMISSIONS } from '../../config/permissions.js'
import { sendVerificationEmail } from '../auth/auth.service.js'
import {
  AI_STUDIO_CODE_PREFIX,
  assertGrantable,
  codesKeptOnRoleChange,
  inScope,
  isGrantable,
  permissionRefusal,
  type PermissionScope,
} from './permission-rules.js'
import { USER_SORT_FIELDS, type ListUsersQuery } from './users.schema.js'

const userSelect = {
  id: true,
  email: true,
  role: true,
  status: true,
  firstName: true,
  lastName: true,
  phone: true,
  countryCode: true,
  timezone: true,
  avatarFileId: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect

export async function listUsers(query: ListUsersQuery) {
  const where: Prisma.UserWhereInput = {
    // Archived accounts are hidden by default, same as an archived
    // Organisation — but, unlike Organisation (which has no way back),
    // explicitly asking for ARCHIVED here still finds them.
    ...(query.status === UserStatus.ARCHIVED ? {} : { deletedAt: null }),
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
    /**
     * Every TERM must match some column, rather than the whole string
     * matching one. A name lives across firstName and lastName, so searching
     * one — the obvious thing to type — matched nothing before this.
     */
    ...(searchTerms(query.search).length > 0
      ? {
          AND: searchTerms(query.search).map((term) => ({
            OR: [
              { email: { contains: term, mode: 'insensitive' as const } },
              { firstName: { contains: term, mode: 'insensitive' as const } },
              { lastName: { contains: term, mode: 'insensitive' as const } },
            ],
          })),
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        ...userSelect,
        orgMemberships: { select: { organisation: { select: { id: true, name: true } } } },
        testerProfile: { select: { id: true, status: true } },
      },
      orderBy: buildOrderBy(query.sort, query.order, USER_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.user.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

export async function getUser(id: string) {
  // No deletedAt restriction here, deliberately — an admin opening a
  // specific record by id should see it regardless of archived state, the
  // same way list visibility doesn't gate a direct, deliberate open.
  const user = await prisma.user.findFirst({
    where: { id },
    select: {
      ...userSelect,
      permissions: { select: { permission: { select: { code: true, label: true, group: true } } } },
      orgMemberships: {
        select: { orgRole: true, organisation: { select: { id: true, name: true, status: true } } },
      },
      testerProfile: { select: { id: true, status: true, ratingAverage: true } },
      _count: { select: { bugsReported: true, assignments: true, projectsCreated: true } },
    },
  })
  if (!user) throw new NotFoundError('User')
  return user
}

/**
 * ADMIN is the only role that can touch ADMIN. `user.write` is a day-to-day
 * Sub-Admin permission, so without this it reaches every account above it,
 * including its holder's own promotion. Pass `newRole` when one is being set.
 */
export async function assertMayManage(
  actor: Express.AuthenticatedUser,
  targetId: string,
  newRole?: Role,
): Promise<void> {
  if (actor.role === Role.ADMIN) return
  if (newRole === Role.ADMIN) {
    throw new ForbiddenError('Only an administrator can assign the administrator role')
  }
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true } })
  if (target?.role === Role.ADMIN) {
    throw new ForbiddenError('Only an administrator can change an administrator account')
  }
}

/**
 * Nobody hands out what they do not hold, ADMIN excepted. `keeping` is what the
 * target already has: re-saving a grant set is not granting those codes again.
 */
function assertMayGrant(
  actor: Express.AuthenticatedUser,
  codes: readonly string[],
  keeping: readonly string[] = [],
): void {
  if (actor.role === Role.ADMIN) return
  const allowed = new Set([...actor.permissions, ...keeping])
  const beyond = codes.filter((code) => !allowed.has(code))
  if (beyond.length > 0) {
    throw new ForbiddenError(`You cannot grant what you do not hold: ${beyond.join(', ')}`)
  }
}

interface NewUser {
  email: string
  password: string
  role: Role
  firstName: string
  lastName?: string
  phone?: string
  countryCode?: string
  permissionCodes?: string[]
  activateImmediately: boolean
}

export async function createUser(actor: Express.AuthenticatedUser, input: NewUser) {
  if (actor.role !== Role.ADMIN && input.role === Role.ADMIN) {
    throw new ForbiddenError('Only an administrator can assign the administrator role')
  }
  const grantCodes = input.permissionCodes?.length
    ? input.permissionCodes
    : DEFAULT_SUBADMIN_PERMISSIONS
  if (input.role === Role.SUB_ADMIN) assertMayGrant(actor, grantCodes)

  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (existing) throw new ConflictError('An account with this email already exists')

  const passwordHash = await hashPassword(input.password)

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        role: input.role,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        phone: input.phone ?? null,
        countryCode: input.countryCode ?? null,
        status: input.activateImmediately ? UserStatus.ACTIVE : UserStatus.PENDING,
        emailVerifiedAt: input.activateImmediately ? new Date() : null,
      },
      select: userSelect,
    })

    // An admin-created tester still needs a profile row to exist.
    if (input.role === Role.TESTER) {
      await tx.testerProfile.create({
        data: {
          userId: user.id,
          status: TesterStatus.PENDING,
          countryCode: input.countryCode ?? null,
        },
      })
    }

    if (input.role === Role.SUB_ADMIN) {
      await grantPermissions(tx, user.id, grantCodes, null)
    }

    return user
  })
}

/**
 * `countryCode` is duplicated onto `TesterProfile` (the Testers tab reads its
 * own copy, not `User.countryCode` — see schema.prisma) because a tester's
 * profile is meant to stand alone. Editing it only here left the two
 * silently diverging: an admin correcting a tester's country from the Users
 * tab never showed up on that same person's Testers page. `updateMany`
 * rather than `update` because most users have no `TesterProfile` row at
 * all, which should be a no-op, not a "record not found" error.
 */
export async function updateUser(id: string, input: Record<string, unknown>) {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true } })
  if (!user) throw new NotFoundError('User')

  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: input,
      select: userSelect,
    }),
    ...('countryCode' in input
      ? [
          prisma.testerProfile.updateMany({
            where: { userId: id },
            data: { countryCode: input.countryCode as string | null },
          }),
        ]
      : []),
  ])

  return updated
}

/**
 * Role changes are deliberately narrow.
 *
 * Returns the codes the change revoked, so the route can put them in the
 * audit entry: a grant disappearing as a side effect of a role change should
 * be as traceable as one withdrawn in the permissions editor.
 * Promoting into or out of ADMIN is
 * allowed, but the last remaining active ADMIN can never be demoted — that
 * would lock everybody out of the back office.
 */
export async function changeRole(actor: Express.AuthenticatedUser, id: string, role: Role) {
  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, role: true },
  })
  if (!user) throw new NotFoundError('User')
  if (user.role === role) {
    const unchanged = await prisma.user.findUnique({ where: { id }, select: userSelect })
    return { user: unchanged, revokedPermissionCodes: [] as string[] }
  }

  if (user.role === Role.ADMIN && role !== Role.ADMIN) {
    await assertNotLastAdmin(id)
  }
  if (role === Role.SUB_ADMIN) assertMayGrant(actor, DEFAULT_SUBADMIN_PERMISSIONS)

  return prisma.$transaction(async (tx) => {
    // Grants the new role may not hold are dropped; see codesKeptOnRoleChange.
    // Leaving SUB_ADMIN still clears every grant, as it always has.
    const held = await tx.userPermission.findMany({
      where: { userId: id },
      select: { permission: { select: { code: true } } },
    })
    const heldCodes = held.map((grant) => grant.permission.code)
    const kept = new Set(codesKeptOnRoleChange(user.role, role, heldCodes))
    const revokedPermissionCodes = heldCodes.filter((code) => !kept.has(code))
    if (revokedPermissionCodes.length > 0) {
      await tx.userPermission.deleteMany({
        where: { userId: id, permission: { code: { in: revokedPermissionCodes } } },
      })
    }
    if (role === Role.SUB_ADMIN && user.role !== Role.SUB_ADMIN) {
      await grantPermissions(tx, id, DEFAULT_SUBADMIN_PERMISSIONS, actor.id)
    }
    if (role === Role.TESTER) {
      await tx.testerProfile.upsert({
        where: { userId: id },
        create: { userId: id, status: TesterStatus.PENDING },
        update: {},
      })
    }
    const updated = await tx.user.update({ where: { id }, data: { role }, select: userSelect })
    return { user: updated, revokedPermissionCodes }
  })
}

export async function changeStatus(id: string, status: UserStatus) {
  // No deletedAt restriction here, deliberately — an already-archived user
  // (deletedAt set) must still be reachable through this same action in
  // order to be reinstated.
  const user = await prisma.user.findFirst({
    where: { id },
    select: { id: true, role: true, status: true },
  })
  if (!user) throw new NotFoundError('User')

  if (user.role === Role.ADMIN && status !== UserStatus.ACTIVE) {
    await assertNotLastAdmin(id)
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id },
      data: {
        status,
        // Hidden from default list views while archived, reinstated
        // (findable again) otherwise — mirrors Organisation.archiveOrganisation,
        // but unlike it, reachable again via an explicit status=ARCHIVED filter.
        deletedAt: status === UserStatus.ARCHIVED ? new Date() : null,
      },
      select: userSelect,
    })
    // Suspending or deactivating ends every live session. With stateful auth
    // this cuts access on the target's very next request.
    if (status !== UserStatus.ACTIVE) {
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'account_suspended' },
      })
    }
    await syncTesterArchivedState(tx, id, status)
    return updated
  })
}

/**
 * Keeps a tester's profile archived in lock-step with their account.
 * ARCHIVED is never set directly on a TesterProfile (see `changeTesterStatus`
 * in testers.service.ts) — it only ever follows from the underlying account
 * being archived here or in `deleteUser`. Reinstating clears the hide-flag
 * and lands the profile at PENDING: restoring its exact prior status isn't
 * tracked anywhere, so "needs a fresh look" is the conservative choice.
 * `updateMany` rather than `update` because most users have no
 * TesterProfile at all, which should be a no-op, not a "not found" error.
 */
async function syncTesterArchivedState(
  tx: Prisma.TransactionClient,
  userId: string,
  status: UserStatus,
): Promise<void> {
  if (status === UserStatus.ARCHIVED) {
    await tx.testerProfile.updateMany({
      where: { userId },
      data: { status: TesterStatus.ARCHIVED, deletedAt: new Date() },
    })
  } else {
    // Only a profile that is CURRENTLY archived is reinstated here — an
    // unrelated status change (e.g. suspending an account) must not touch a
    // tester profile that was never archived in the first place.
    await tx.testerProfile.updateMany({
      where: { userId, status: TesterStatus.ARCHIVED },
      data: { status: TesterStatus.PENDING, deletedAt: null },
    })
  }
}

/**
 * An administrator sending a fresh verification link on a user's behalf —
 * the same mail `resendVerification` (auth.service.ts) sends, but that one is
 * a public, unauthenticated endpoint that must stay silent about whether an
 * email exists at all. Here the caller already knows: they are looking at
 * this exact account, so a clear 409 for "already verified" is useful
 * feedback rather than an enumeration leak.
 */
export async function resendVerificationEmail(id: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, email: true, emailVerifiedAt: true },
  })
  if (!user) throw new NotFoundError('User')
  if (user.emailVerifiedAt) throw new ConflictError('This account has already verified its email')

  await sendVerificationEmail(user.id, user.email)
}

/** Soft delete. The row stays for audit and referential integrity. */
export async function deleteUser(id: string) {
  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, role: true, email: true },
  })
  if (!user) throw new NotFoundError('User')
  if (user.role === Role.ADMIN) await assertNotLastAdmin(id)

  return prisma.$transaction(async (tx) => {
    await tx.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'account_deleted' },
    })
    const updated = await tx.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: UserStatus.ARCHIVED,
        // Free the address for reuse while keeping the row traceable.
        email: `deleted+${id}@crowd4test.invalid`,
      },
      select: { id: true, deletedAt: true },
    })
    await syncTesterArchivedState(tx, id, UserStatus.ARCHIVED)
    return updated
  })
}

async function assertNotLastAdmin(excludingUserId: string): Promise<void> {
  const remaining = await prisma.user.count({
    where: {
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      deletedAt: null,
      id: { not: excludingUserId },
    },
  })
  if (remaining === 0) {
    throw new ConflictError(
      'This is the last active administrator and cannot be removed or demoted',
    )
  }
}

// ─── Permissions (§2.2, and AI Studio access) ────────────────────────────────

/**
 * The catalogue, optionally narrowed to what one kind of account may be given
 * — the AI Studio access panel offers a tester only the codes the API would
 * accept for a tester.
 */
export async function listPermissionCatalogue(grantableTo?: Role) {
  const permissions = await prisma.permission.findMany({
    orderBy: [{ group: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, group: true, label: true, description: true },
  })
  // Fall back to the in-code catalogue if the table has not been seeded yet.
  const catalogue = permissions.length > 0 ? permissions : PERMISSION_CATALOGUE
  return grantableTo
    ? catalogue.filter((permission) => isGrantable(grantableTo, permission.code))
    : catalogue
}

export async function getUserPermissions(userId: string) {
  const grants = await prisma.userPermission.findMany({
    where: { userId },
    select: {
      grantedAt: true,
      permission: { select: { id: true, code: true, group: true, label: true } },
    },
  })
  return grants.map((g) => ({ ...g.permission, grantedAt: g.grantedAt }))
}

/** Prisma filter for the grants one scope covers. */
function scopeWhere(scope: PermissionScope): Prisma.UserPermissionWhereInput {
  if (scope === 'ai_studio') return { permission: { code: { startsWith: AI_STUDIO_CODE_PREFIX } } }
  if (scope === 'back_office') {
    return { NOT: { permission: { code: { startsWith: AI_STUDIO_CODE_PREFIX } } } }
  }
  return {}
}

/**
 * Replaces a person's grant set wholesale — or, with a `scope`, only the AI
 * Studio codes or only the back-office ones, leaving the rest untouched.
 *
 * Sub-admins may hold any code; customers and testers only the AI Studio codes
 * their kind of account allows (see permission-rules.ts). Returns the codes
 * held before, for the audit entry.
 */
export async function setUserPermissions(
  actor: Express.AuthenticatedUser,
  userId: string,
  codes: string[],
  scope: PermissionScope = 'all',
) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, role: true },
  })
  if (!user) throw new NotFoundError('User')
  if (user.role === Role.ADMIN || user.role === Role.USER) {
    throw new BadRequestError(permissionRefusal(user.role, '')!)
  }
  if (userId === actor.id) {
    throw new ForbiddenError('You cannot change your own permissions')
  }
  if (actor.role !== Role.ADMIN) {
    const current = await getUserPermissions(userId)
    assertMayGrant(
      actor,
      codes,
      current.map((grant) => grant.code),
    )
  }

  const outside = codes.filter((code) => !inScope(scope, code))
  if (outside.length > 0) {
    throw new BadRequestError(
      scope === 'ai_studio'
        ? 'Only AI Studio features can be set here.'
        : 'AI Studio features are set in the AI Studio access panel.',
      { refused: outside },
    )
  }
  assertGrantable(user.role, codes)

  return prisma.$transaction(async (tx) => {
    const before = await tx.userPermission.findMany({
      where: { userId, ...scopeWhere(scope) },
      select: { permission: { select: { code: true } } },
    })
    await tx.userPermission.deleteMany({ where: { userId, ...scopeWhere(scope) } })
    await grantPermissions(tx, userId, codes, actor.id)
    return {
      previousCodes: before.map((grant) => grant.permission.code),
      permissions: await getUserPermissionsTx(tx, userId),
    }
  })
}

async function grantPermissions(
  tx: Prisma.TransactionClient,
  userId: string,
  codes: string[],
  grantedById: string | null,
): Promise<void> {
  if (codes.length === 0) return

  const permissions = await tx.permission.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true },
  })

  const found = new Set(permissions.map((p) => p.code))
  const unknown = codes.filter((c) => !found.has(c))
  if (unknown.length > 0) {
    throw new BadRequestError(`Unknown permission code(s): ${unknown.join(', ')}`)
  }

  await tx.userPermission.createMany({
    data: permissions.map((p) => ({ userId, permissionId: p.id, grantedById })),
    skipDuplicates: true,
  })
}

async function getUserPermissionsTx(tx: Prisma.TransactionClient, userId: string) {
  const grants = await tx.userPermission.findMany({
    where: { userId },
    select: { permission: { select: { id: true, code: true, group: true, label: true } } },
  })
  return grants.map((g) => g.permission)
}

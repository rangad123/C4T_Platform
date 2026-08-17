import { type Prisma, TesterStatus, Role, UserStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, BadRequestError, ForbiddenError } from '../../lib/errors.js'
import { buildMeta, buildOrderBy, toSkipTake } from '../../lib/pagination.js'
import {
  TESTER_SORT_FIELDS,
  DEVICE_SORT_FIELDS,
  type ListTestersQuery,
  type ListGlobalDevicesQuery,
} from './testers.schema.js'
import { createNotification } from '../notifications/notifications.service.js'

const profileSelect = {
  id: true,
  status: true,
  headline: true,
  bio: true,
  experienceYears: true,
  city: true,
  countryCode: true,
  ratingAverage: true,
  ratingCount: true,
  bugsReportedCount: true,
  bugsAcceptedCount: true,
  projectsCompletedCount: true,
  verifiedAt: true,
  rejectionReason: true,
  ndaAcceptedAt: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      avatarFileId: true,
      phone: true,
      timezone: true,
      role: true,
      lastLoginAt: true,
      createdAt: true,
    },
  },
  devices: true,
  skills: { select: { skill: { select: { id: true, name: true, slug: true, category: true } } } },
  languages: { select: { code: true, proficiency: true } },
  workHistory: { orderBy: { startDate: 'desc' } },
} satisfies Prisma.TesterProfileSelect

/** §2.2 Crowd Tester Management — the admin-facing pool list. */
export async function listTesters(query: ListTestersQuery) {
  const where: Prisma.TesterProfileWhereInput = {
    user: { deletedAt: null },
    ...(query.status ? { status: query.status } : {}),
    ...(query.countryCode ? { countryCode: query.countryCode } : {}),
    ...(query.minRating !== undefined ? { ratingAverage: { gte: query.minRating } } : {}),
    ...(query.deviceType ? { devices: { some: { type: query.deviceType } } } : {}),
    ...(query.languages?.length ? { languages: { some: { code: { in: query.languages } } } } : {}),
    // Every requested skill must be present, so one AND clause per slug.
    ...(query.skills?.length
      ? { AND: query.skills.map((slug) => ({ skills: { some: { skill: { slug } } } })) }
      : {}),
    ...(query.search
      ? {
          OR: [
            { user: { email: { contains: query.search, mode: 'insensitive' } } },
            { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
            { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
            { headline: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.testerProfile.findMany({
      where,
      select: profileSelect,
      orderBy: buildOrderBy(query.sort, query.order, TESTER_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.testerProfile.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

/**
 * CSV export of the same row set the list endpoint returns, minus pagination.
 * Reuses the exact `where` clause from `listTesters` so the filters are
 * identical — exporting never bypasses any filter or scope.
 */
export async function exportTestersCSV(query: ListTestersQuery): Promise<string> {
  const where: Prisma.TesterProfileWhereInput = {
    user: { deletedAt: null },
    ...(query.status ? { status: query.status } : {}),
    ...(query.countryCode ? { countryCode: query.countryCode } : {}),
    ...(query.minRating !== undefined ? { ratingAverage: { gte: query.minRating } } : {}),
    ...(query.deviceType ? { devices: { some: { type: query.deviceType } } } : {}),
    ...(query.languages?.length ? { languages: { some: { code: { in: query.languages } } } } : {}),
    ...(query.skills?.length
      ? { AND: query.skills.map((slug) => ({ skills: { some: { skill: { slug } } } })) }
      : {}),
    ...(query.search
      ? {
          OR: [
            { user: { email: { contains: query.search, mode: 'insensitive' } } },
            { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
            { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
            { headline: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const items = await prisma.testerProfile.findMany({
    where,
    select: profileSelect,
    orderBy: buildOrderBy(query.sort, query.order, TESTER_SORT_FIELDS, 'createdAt'),
  })

  const rows = items.map((t) => [
    [t.user?.firstName, t.user?.lastName].filter(Boolean).join(' '),
    t.user?.email ?? '',
    t.status,
    t.headline ?? '',
    t.experienceYears ?? '',
    t.city ?? '',
    t.countryCode ?? '',
    t.ratingAverage === null ? '' : t.ratingAverage.toFixed(1),
    t.ratingCount,
    t.bugsReportedCount,
    t.bugsAcceptedCount,
    t.projectsCompletedCount,
    t.skills.map((s) => s.skill.name).join('|'),
    t.languages.map((l) => l.code).join('|'),
    t.verifiedAt,
    t.createdAt,
  ])

  const { toCsv } = await import('../../lib/csv.js')
  return toCsv(
    [
      'Name',
      'Email',
      'Status',
      'Headline',
      'Experience (years)',
      'City',
      'Country',
      'Rating',
      'Reviews',
      'Bugs reported',
      'Bugs accepted',
      'Projects completed',
      'Skills',
      'Languages',
      'Verified at',
      'Applied at',
    ],
    rows,
  )
}

const globalDeviceSelect = {
  id: true,
  type: true,
  manufacturer: true,
  model: true,
  osName: true,
  osVersion: true,
  screenSize: true,
  ramGb: true,
  network: true,
  browser: true,
  isPrimary: true,
  createdAt: true,
  testerProfile: {
    select: {
      id: true,
      countryCode: true,
      user: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.TesterDeviceSelect

/**
 * §18 "Global Assets Management" — every device (and, filtered, every
 * recorded browser) across every tester, browsable by an admin. See the
 * schema-level note on `listGlobalDevicesQuery` for why this reads from
 * `TesterDevice` rather than a separate catalogue table.
 */
export async function listGlobalDevices(query: ListGlobalDevicesQuery) {
  const where: Prisma.TesterDeviceWhereInput = {
    // Both conditions target the same relation, so they're merged into one
    // `testerProfile` filter rather than spread as separate top-level keys —
    // two `...(cond ? {testerProfile: ...} : {})` spreads would silently
    // overwrite each other instead of combining.
    testerProfile: {
      user: { deletedAt: null },
      ...(query.countryCode ? { countryCode: query.countryCode } : {}),
    },
    ...(query.type ? { type: query.type } : {}),
    ...(query.onlyWithBrowser ? { browser: { not: null } } : {}),
    ...(query.search
      ? {
          OR: [
            { model: { contains: query.search, mode: 'insensitive' } },
            { manufacturer: { contains: query.search, mode: 'insensitive' } },
            { browser: { contains: query.search, mode: 'insensitive' } },
            { osName: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [items, total] = await Promise.all([
    prisma.testerDevice.findMany({
      where,
      select: globalDeviceSelect,
      orderBy: buildOrderBy(query.sort, query.order, DEVICE_SORT_FIELDS, 'createdAt'),
      ...toSkipTake(query),
    }),
    prisma.testerDevice.count({ where }),
  ])

  return { items, meta: buildMeta(query, total) }
}

export async function getTesterById(id: string) {
  const profile = await prisma.testerProfile.findUnique({ where: { id }, select: profileSelect })
  if (!profile) throw new NotFoundError('Tester')
  return profile
}

/** §2.3 — the tester's own profile. */
export async function getMyProfile(userId: string) {
  const profile = await prisma.testerProfile.findUnique({
    where: { userId },
    select: profileSelect,
  })
  if (!profile) throw new NotFoundError('Tester profile')
  return profile
}

async function requireOwnProfile(userId: string) {
  const profile = await prisma.testerProfile.findUnique({
    where: { userId },
    select: { id: true, status: true },
  })
  if (!profile) throw new NotFoundError('Tester profile')
  return profile
}

export async function updateMyProfile(userId: string, input: Record<string, unknown>) {
  const profile = await requireOwnProfile(userId)
  return prisma.testerProfile.update({
    where: { id: profile.id },
    data: input,
    select: profileSelect,
  })
}

/**
 * §2.2 — Admin moves a tester through the onboarding pipeline.
 * Suspending a tester also suspends the underlying user account, so their
 * session is cut off at the next request (see authenticate middleware).
 */
export async function changeTesterStatus(
  actorId: string,
  testerProfileId: string,
  status: TesterStatus,
  reason?: string,
) {
  const profile = await prisma.testerProfile.findUnique({
    where: { id: testerProfileId },
    select: { id: true, status: true, userId: true },
  })
  if (!profile) throw new NotFoundError('Tester')

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.testerProfile.update({
      where: { id: testerProfileId },
      data: {
        status,
        verifiedAt: status === TesterStatus.VERIFIED ? new Date() : null,
        verifiedById: status === TesterStatus.VERIFIED ? actorId : null,
        rejectionReason: status === TesterStatus.REJECTED ? (reason ?? null) : null,
      },
      select: profileSelect,
    })

    if (status === TesterStatus.SUSPENDED) {
      await tx.user.update({
        where: { id: profile.userId },
        data: { status: UserStatus.SUSPENDED },
      })
    } else if (profile.status === TesterStatus.SUSPENDED) {
      // Reinstating: return the account to ACTIVE only if it was suspended.
      await tx.user.updateMany({
        where: { id: profile.userId, status: UserStatus.SUSPENDED },
        data: { status: UserStatus.ACTIVE },
      })
    }

    return result
  })

  await createNotification({
    userId: profile.userId,
    type: 'TESTER_STATUS_CHANGED',
    title: `Your tester status is now ${status.toLowerCase().replace('_', ' ')}`,
    body: reason ?? undefined,
    link: '/app/tester/profile',
  })

  return updated
}

// ─── Devices ─────────────────────────────────────────────────────────────────

export async function addDevice(
  userId: string,
  input: Omit<Prisma.TesterDeviceUncheckedCreateInput, 'id' | 'testerProfileId' | 'createdAt'>,
) {
  const profile = await requireOwnProfile(userId)

  return prisma.$transaction(async (tx) => {
    // Only one device can be primary, so clear the flag before setting a new one.
    if (input.isPrimary === true) {
      await tx.testerDevice.updateMany({
        where: { testerProfileId: profile.id },
        data: { isPrimary: false },
      })
    }
    return tx.testerDevice.create({
      data: { ...input, testerProfileId: profile.id },
    })
  })
}

export async function removeDevice(userId: string, deviceId: string) {
  const profile = await requireOwnProfile(userId)
  const device = await prisma.testerDevice.findUnique({
    where: { id: deviceId },
    select: { testerProfileId: true },
  })
  if (!device) throw new NotFoundError('Device')
  if (device.testerProfileId !== profile.id) {
    throw new ForbiddenError('That device belongs to another tester')
  }
  await prisma.testerDevice.delete({ where: { id: deviceId } })
}

// ─── Work history ─────────────────────────────────────────────────────────────

export async function addWorkHistory(
  userId: string,
  input: Omit<Prisma.TesterWorkHistoryUncheckedCreateInput, 'id' | 'testerProfileId' | 'createdAt'>,
) {
  const profile = await requireOwnProfile(userId)
  return prisma.testerWorkHistory.create({
    data: { ...input, testerProfileId: profile.id },
  })
}

export async function removeWorkHistory(userId: string, workHistoryId: string) {
  const profile = await requireOwnProfile(userId)
  const entry = await prisma.testerWorkHistory.findUnique({
    where: { id: workHistoryId },
    select: { testerProfileId: true },
  })
  if (!entry) throw new NotFoundError('Work history entry')
  if (entry.testerProfileId !== profile.id) {
    throw new ForbiddenError('That work history entry belongs to another tester')
  }
  await prisma.testerWorkHistory.delete({ where: { id: workHistoryId } })
}

// ─── Skills & languages ──────────────────────────────────────────────────────

/**
 * Replaces the tester's skill set, creating any skill that does not yet exist.
 *
 * ── Why the transaction is kept deliberately small
 *
 * Only the delete-then-recreate of THIS tester's rows needs atomicity — a
 * tester must never be observable with a half-replaced skill set. Two other
 * things used to sit inside the same transaction and do not belong there:
 *
 *   1. The `skill.upsert` calls. Those create rows in the GLOBAL skill
 *      catalogue, are idempotent, and are not part of the tester's set being
 *      swapped — if the swap below fails, an extra catalogue row is harmless.
 *   2. The final profile read. It only builds the response payload, and
 *      reading it after the commit is if anything more correct, since it is
 *      then guaranteed to reflect committed state.
 *
 * Keeping them inside cost real correctness, not just speed: each Prisma
 * round trip to a remote Postgres is ~1s, `profileSelect` fans out across
 * five relations, and the interactive-transaction budget is 5s — so a tester
 * saving three or more skills reliably blew the timeout and got a 400 with
 * nothing saved. Two writes is well inside the budget.
 */
export async function setSkills(userId: string, slugs: string[]) {
  const profile = await requireOwnProfile(userId)
  const normalised = [...new Set(slugs.map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')))]

  // Outside the transaction — see the note above.
  const skills = await Promise.all(
    normalised.map((slug) =>
      prisma.skill.upsert({
        where: { slug },
        create: { slug, name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) },
        update: {},
        select: { id: true },
      }),
    ),
  )

  await prisma.$transaction(async (tx) => {
    await tx.testerSkill.deleteMany({ where: { testerProfileId: profile.id } })
    if (skills.length > 0) {
      await tx.testerSkill.createMany({
        data: skills.map((s) => ({ testerProfileId: profile.id, skillId: s.id })),
      })
    }
  })

  return prisma.testerProfile.findUnique({ where: { id: profile.id }, select: profileSelect })
}

/**
 * Lists every skill in the catalogue, with how many testers carry it. Used by
 * the admin skill-browser to assign categories. Sorted by category then name
 * so the same category clusters together.
 */
export async function listSkillCatalogue() {
  const skills = await prisma.skill.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      category: true,
      _count: { select: { testers: true } },
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })
  return skills
}

/** Admin: re-classify a skill. */
export async function setSkillCategory(
  skillId: string,
  category: 'DOMAIN' | 'TYPE' | 'TOOL' | 'APPLICATION',
) {
  const skill = await prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } })
  if (!skill) throw new NotFoundError('Skill')
  return prisma.skill.update({ where: { id: skillId }, data: { category } })
}

/** Replaces the tester's language set. Same transaction-scoping rationale as `setSkills`. */
export async function setLanguages(
  userId: string,
  languages: { code: string; proficiency: string }[],
) {
  const profile = await requireOwnProfile(userId)

  await prisma.$transaction(async (tx) => {
    await tx.testerLanguage.deleteMany({ where: { testerProfileId: profile.id } })
    if (languages.length > 0) {
      await tx.testerLanguage.createMany({
        data: languages.map((l) => ({ ...l, testerProfileId: profile.id })),
      })
    }
  })

  return prisma.testerProfile.findUnique({ where: { id: profile.id }, select: profileSelect })
}

export async function acceptNda(userId: string) {
  const profile = await requireOwnProfile(userId)
  return prisma.testerProfile.update({
    where: { id: profile.id },
    data: { ndaAcceptedAt: new Date() },
    select: { id: true, ndaAcceptedAt: true },
  })
}

/**
 * Recomputes the denormalised counters on a tester profile. Called after bug
 * and rating writes rather than on read, because the admin pool list sorts on
 * these columns.
 */
export async function refreshTesterAggregates(userId: string): Promise<void> {
  const profile = await prisma.testerProfile.findUnique({
    where: { userId },
    select: { id: true },
  })
  if (!profile) return

  const [bugStats, acceptedCount, ratingStats, completedCount] = await Promise.all([
    prisma.bug.count({ where: { reportedById: userId, deletedAt: null } }),
    prisma.bug.count({
      where: {
        reportedById: userId,
        deletedAt: null,
        status: { in: ['CONFIRMED', 'FIXED', 'VERIFIED'] },
      },
    }),
    prisma.rating.aggregate({
      where: { subjectUserId: userId, subjectType: 'TESTER', isVisible: true },
      _avg: { score: true },
      _count: { score: true },
    }),
    prisma.projectAssignment.count({ where: { testerId: userId, status: 'COMPLETED' } }),
  ])

  await prisma.testerProfile.update({
    where: { id: profile.id },
    data: {
      bugsReportedCount: bugStats,
      bugsAcceptedCount: acceptedCount,
      ratingAverage: ratingStats._avg.score ?? null,
      ratingCount: ratingStats._count.score,
      projectsCompletedCount: completedCount,
    },
  })
}

/**
 * Guard used before assigning a tester to a project (§2.2 Project Management).
 * Only a verified tester who has accepted the NDA may be assigned work.
 */
export async function assertAssignable(testerUserId: string): Promise<void> {
  const profile = await prisma.testerProfile.findUnique({
    where: { userId: testerUserId },
    select: { status: true, ndaAcceptedAt: true, user: { select: { role: true, status: true } } },
  })

  if (!profile) throw new BadRequestError('That user is not a tester')
  if (profile.user.role !== Role.TESTER) throw new BadRequestError('That user is not a tester')
  if (profile.status !== TesterStatus.VERIFIED) {
    throw new BadRequestError('Only verified testers can be assigned to a project')
  }
  if (profile.user.status !== UserStatus.ACTIVE) {
    throw new BadRequestError('That tester account is not active')
  }
  if (!profile.ndaAcceptedAt) {
    throw new BadRequestError('That tester has not accepted the NDA yet')
  }
}

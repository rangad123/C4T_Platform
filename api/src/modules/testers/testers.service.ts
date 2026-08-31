import { type Prisma, BugStatus, TesterStatus, Role, UserStatus } from '@prisma/client'
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

/**
 * A bug that "counts" for the tester who reported it.
 *
 * Exported because the per-project work history reuses it: two definitions of
 * "accepted" that could drift would put a different number on the profile
 * header than on the project row underneath it.
 */
export const ACCEPTED_BUG_STATUSES: BugStatus[] = [
  BugStatus.CONFIRMED,
  BugStatus.FIXED,
  BugStatus.VERIFIED,
]

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
  gender: true,
  ageGroup: true,
  lookingFor: true,
  skype: true,
  linkedinUrl: true,
  profession: true,
  verifiedAt: true,
  rejectionReason: true,
  ndaAcceptedAt: true,
  ndaFileId: true,
  ndaFile: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
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
  skills: {
    select: {
      skill: {
        select: {
          id: true,
          name: true,
          slug: true,
          category: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  },
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
    // `ndaAcceptedAt` is here so `setNdaDocument` can preserve an existing
    // acceptance timestamp rather than overwriting it with today's date.
    select: { id: true, status: true, ndaAcceptedAt: true },
  })
  if (!profile) throw new NotFoundError('Tester profile')
  return profile
}

/**
 * Free-text profile columns a tester may blank out.
 *
 * The schema lets these through as `''`; the column is nullable. Writing the
 * empty string instead of null would leave the field "set to nothing", which
 * then renders as an empty value rather than the em dash every other unset
 * field shows — so the two representations are collapsed here, once, rather
 * than at each of the half-dozen read sites.
 */
const CLEARABLE_PROFILE_FIELDS = [
  'headline',
  'bio',
  'city',
  'countryCode',
  'gender',
  'ageGroup',
  'lookingFor',
  'skype',
  'linkedinUrl',
  'profession',
] as const

export async function updateMyProfile(userId: string, input: Record<string, unknown>) {
  const profile = await requireOwnProfile(userId)

  const data: Record<string, unknown> = { ...input }
  for (const field of CLEARABLE_PROFILE_FIELDS) {
    if (data[field] === '') data[field] = null
  }

  return prisma.testerProfile.update({
    where: { id: profile.id },
    data,
    select: profileSelect,
  })
}

/**
 * Attach the tester's signed NDA.
 *
 * The file must be one this tester uploaded and finished — the same rule bug
 * attachments enforce. Without that check a tester could point their profile
 * at any file id in the system and have the admin NDA panel serve it back.
 */
export async function setNdaDocument(userId: string, fileId: string) {
  const profile = await requireOwnProfile(userId)

  const file = await prisma.fileObject.findUnique({
    where: { id: fileId },
    select: { id: true, uploadedById: true, isComplete: true },
  })
  if (!file?.isComplete) throw new NotFoundError('File')
  if (file.uploadedById !== userId) {
    throw new ForbiddenError('That file belongs to someone else')
  }

  return prisma.testerProfile.update({
    where: { id: profile.id },
    // Returning the NDA document also counts as accepting it — a tester who
    // signed and returned the paper has done strictly more than clicking the
    // online acceptance, so recording only the file would leave the profile
    // reading "NDA not accepted" while holding a signed copy.
    data: { ndaFileId: fileId, ndaAcceptedAt: profile.ndaAcceptedAt ?? new Date() },
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

/**
 * Catalog fields a device may be submitted with, mapped to the free-text
 * columns they mirror into on create. A catalog pick fills the matching
 * free-text field ONLY when the caller left it blank — an explicit typed
 * value always wins, since it describes this tester's actual unit more
 * precisely than the catalog default (e.g. a modified/unusual OS string).
 */
async function resolveDeviceCatalogMirror(
  input: Prisma.TesterDeviceUncheckedCreateInput,
): Promise<Partial<Prisma.TesterDeviceUncheckedCreateInput>> {
  const mirror: Partial<Prisma.TesterDeviceUncheckedCreateInput> = {}

  if (input.deviceModelId && !input.manufacturer) {
    const model = await prisma.deviceModel.findUnique({
      where: { id: input.deviceModelId },
      select: { brand: { select: { name: true } } },
    })
    // `model` (the free-text model name) is always caller-supplied — the
    // brief treats the exact model name as tester input even when the brand
    // is picked from the catalog, since model names vary more than the
    // catalog can keep pace with. Only the brand mirrors here.
    if (model) mirror.manufacturer = model.brand.name
  }
  if (input.osVersionRefId && !input.osName && !input.osVersion) {
    const version = await prisma.osVersion.findUnique({
      where: { id: input.osVersionRefId },
      select: { version: true, operatingSystem: { select: { name: true } } },
    })
    if (version) {
      mirror.osName = version.operatingSystem.name
      mirror.osVersion = version.version
    }
  }
  if (input.primaryNetworkId && !input.network) {
    const network = await prisma.networkProvider.findUnique({
      where: { id: input.primaryNetworkId },
      select: { name: true },
    })
    if (network) mirror.network = network.name
  }

  return mirror
}

export async function addDevice(
  userId: string,
  input: Omit<Prisma.TesterDeviceUncheckedCreateInput, 'id' | 'testerProfileId' | 'createdAt'>,
) {
  const profile = await requireOwnProfile(userId)
  const mirror = await resolveDeviceCatalogMirror(input as Prisma.TesterDeviceUncheckedCreateInput)

  return prisma.$transaction(async (tx) => {
    // Only one device can be primary, so clear the flag before setting a new one.
    if (input.isPrimary === true) {
      await tx.testerDevice.updateMany({
        where: { testerProfileId: profile.id },
        data: { isPrimary: false },
      })
    }
    return tx.testerDevice.create({
      data: { ...input, ...mirror, testerProfileId: profile.id },
    })
  })
}

/**
 * Correct an existing device.
 *
 * Previously the only way to fix a typo was delete-and-re-add, which throws
 * away `createdAt` and reads as destructive for what is really an edit.
 *
 * The catalog mirror runs again on the submitted values, matching `addDevice`
 * — a caller who switches the brand pick and clears the free-text field gets
 * the new brand mirrored in, and one who typed their own value keeps it.
 */
export async function updateDevice(
  userId: string,
  deviceId: string,
  input: Omit<Prisma.TesterDeviceUncheckedCreateInput, 'id' | 'testerProfileId' | 'createdAt'>,
) {
  const profile = await requireOwnProfile(userId)
  const device = await prisma.testerDevice.findUnique({
    where: { id: deviceId },
    select: { testerProfileId: true },
  })
  if (!device) throw new NotFoundError('Device')
  if (device.testerProfileId !== profile.id) {
    throw new ForbiddenError('That device belongs to another tester')
  }

  const mirror = await resolveDeviceCatalogMirror(input as Prisma.TesterDeviceUncheckedCreateInput)

  return prisma.$transaction(async (tx) => {
    // Only one device can be primary, so clear the flag elsewhere before
    // setting it here — same rule the create path enforces.
    if (input.isPrimary === true) {
      await tx.testerDevice.updateMany({
        where: { testerProfileId: profile.id, id: { not: deviceId } },
        data: { isPrimary: false },
      })
    }
    return tx.testerDevice.update({
      where: { id: deviceId },
      data: { ...input, ...mirror },
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
 * Replaces the tester's skill set with a selection from the catalog — no
 * longer free text (§13 "do not allow arbitrary duplicate skill names when a
 * catalog entry already exists"; catalog creation now lives in
 * `catalog.routes.ts`). Ids that don't resolve to an active catalog skill are
 * silently dropped rather than rejecting the whole save: the catalog is
 * fetched separately from this write, so a skill retired between the two
 * requests should not block saving the rest of a valid selection.
 *
 * ── Why the transaction is kept deliberately small
 *
 * Only the delete-then-recreate of THIS tester's rows needs atomicity — a
 * tester must never be observable with a half-replaced skill set. The final
 * profile read does not belong inside it: it only builds the response
 * payload, and reading it after the commit is if anything more correct, since
 * it is then guaranteed to reflect committed state. `profileSelect` fans out
 * across five relations and each Prisma round trip to a remote Postgres is
 * ~1s against a 5s interactive-transaction budget, so keeping the read out
 * matters for the same reason it did when this accepted free text.
 */
export async function setSkills(userId: string, skillIds: string[]) {
  const profile = await requireOwnProfile(userId)
  const requested = [...new Set(skillIds)]

  const valid = await prisma.skill.findMany({
    where: { id: { in: requested }, isActive: true },
    select: { id: true },
  })

  await prisma.$transaction(async (tx) => {
    await tx.testerSkill.deleteMany({ where: { testerProfileId: profile.id } })
    if (valid.length > 0) {
      await tx.testerSkill.createMany({
        data: valid.map((s) => ({ testerProfileId: profile.id, skillId: s.id })),
      })
    }
  })

  return prisma.testerProfile.findUnique({ where: { id: profile.id }, select: profileSelect })
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
        status: { in: ACCEPTED_BUG_STATUSES },
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

// ─── Crowdtester discovery, for the customer side (§44) ──────────────────────

/**
 * What a customer may see of the crowd.
 *
 * ── WHY THIS IS NOT `listTesters`
 *
 * That one is admin tooling: it selects the user's email, the rejection
 * reason, the full work history, and it is gated on the `tester.read`
 * permission a customer does not hold. Reusing it with a different guard would
 * hand a client the pool's contact details. This is a deliberately narrower
 * projection over the same table.
 *
 * Every tester's real name and photo are shown, by product decision — there
 * is no longer an "unworked with" anonymisation tier. Email, phone and
 * payment details are still never included at any stage.
 */
const DISCOVERABLE_TESTER_SELECT = {
  id: true,
  headline: true,
  bio: true,
  profession: true,
  city: true,
  countryCode: true,
  ratingAverage: true,
  ratingCount: true,
  bugsAcceptedCount: true,
  projectsCompletedCount: true,
  experienceYears: true,
  user: { select: { id: true, firstName: true, lastName: true, avatarFileId: true } },
  skills: { select: { skill: { select: { id: true, name: true, slug: true } } }, take: 8 },
  devices: { select: { type: true, osName: true }, take: 6 },
} satisfies Prisma.TesterProfileSelect

type DiscoverableTesterRow = Prisma.TesterProfileGetPayload<{
  select: typeof DISCOVERABLE_TESTER_SELECT
}>

function shapeDiscoverableTester(t: DiscoverableTesterRow) {
  const first = t.user.firstName?.trim() ?? ''
  const last = t.user.lastName?.trim() ?? ''

  return {
    id: t.id,
    displayName: [first, last].filter(Boolean).join(' ') || 'Tester',
    avatarFileId: t.user.avatarFileId,
    headline: t.headline,
    bio: t.bio,
    profession: t.profession,
    city: t.city,
    countryCode: t.countryCode,
    ratingAverage: t.ratingAverage,
    ratingCount: t.ratingCount,
    bugsAcceptedCount: t.bugsAcceptedCount,
    projectsCompletedCount: t.projectsCompletedCount,
    experienceYears: t.experienceYears,
    skills: t.skills.map((s) => s.skill),
    /** Coarse device coverage — a type and an OS, never a specific handset. */
    platforms: [...new Set(t.devices.map((d) => d.osName ?? d.type).filter(Boolean))] as string[],
  }
}

export async function discoverTesters(query: {
  page: number
  limit: number
  search?: string
  countryCode?: string
  skills?: string[]
}) {
  const where = discoverableTesterWhere(query)

  const [items, total] = await Promise.all([
    prisma.testerProfile.findMany({
      where,
      select: DISCOVERABLE_TESTER_SELECT,
      orderBy: [{ ratingAverage: 'desc' }, { bugsAcceptedCount: 'desc' }],
      ...toSkipTake(query),
    }),
    prisma.testerProfile.count({ where }),
  ])

  return {
    items: items.map(shapeDiscoverableTester),
    meta: buildMeta(query, total),
  }
}

/**
 * One row of the crowd, for the profile page a card in `discoverTesters`
 * links to. Same visibility rule as the list — verified testers only, same
 * fields — just a single record instead of a page.
 */
export async function getDiscoverableTester(testerId: string) {
  const tester = await prisma.testerProfile.findFirst({
    where: {
      id: testerId,
      status: TesterStatus.VERIFIED,
      user: { deletedAt: null, status: UserStatus.ACTIVE },
    },
    select: DISCOVERABLE_TESTER_SELECT,
  })
  if (!tester) throw new NotFoundError('Tester')
  return shapeDiscoverableTester(tester)
}

/** Every organisation a user belongs to, for scoping their own reads. */
export async function organisationIdsForUser(userId: string): Promise<string[]> {
  const memberships = await prisma.organisationMember.findMany({
    where: { userId, organisation: { deletedAt: null } },
    select: { organisationId: true },
  })
  return memberships.map((m) => m.organisationId)
}

/**
 * What a tester has done FOR THE CALLER'S ORGANISATION — never for anyone
 * else's.
 *
 * The aggregate counts on a discoverable profile ("projects completed",
 * "bugs accepted") are platform-wide and safe because they are just numbers.
 * Naming the work is different: a project title identifies a client and what
 * they were building, so returning this tester's whole history would leak
 * one customer's roadmap to another simply because they hired the same
 * freelancer. The `organisationId` filter is the entire privacy boundary
 * here, and it is applied in the query rather than after it.
 *
 * The answer this exists to give is "has this tester worked with US before,
 * and how did it go" — which is answerable without naming anyone else.
 */
export async function getTesterEngagementsForOrganisation(
  testerProfileId: string,
  organisationIds: readonly string[],
) {
  // No organisation means nothing of the caller's to have worked on. Return
  // empty rather than unfiltered — an empty scope must never widen to "all".
  if (organisationIds.length === 0) return []

  const tester = await prisma.testerProfile.findFirst({
    where: {
      id: testerProfileId,
      status: TesterStatus.VERIFIED,
      user: { deletedAt: null, status: UserStatus.ACTIVE },
    },
    select: { userId: true },
  })
  if (!tester) throw new NotFoundError('Tester')

  const assignments = await prisma.projectAssignment.findMany({
    where: {
      testerId: tester.userId,
      project: { organisationId: { in: [...organisationIds] }, deletedAt: null },
    },
    select: {
      status: true,
      invitedAt: true,
      respondedAt: true,
      completedAt: true,
      project: { select: { id: true, reference: true, title: true } },
      build: { select: { id: true, name: true, testType: true } },
    },
    orderBy: { invitedAt: 'desc' },
    take: 50,
  })

  /**
   * Bugs this tester filed on those same projects, counted per project.
   * Grouped in one query rather than counted per row — a customer with a
   * long history with one tester would otherwise cost a query per project.
   */
  const projectIds = [...new Set(assignments.map((a) => a.project.id))]
  const bugCounts =
    projectIds.length === 0
      ? []
      : await prisma.bug.groupBy({
          by: ['projectId'],
          where: { projectId: { in: projectIds }, reportedById: tester.userId, deletedAt: null },
          _count: { _all: true },
        })
  const bugsByProject = new Map(bugCounts.map((b) => [b.projectId, b._count._all]))

  return assignments.map((a) => ({
    status: a.status,
    invitedAt: a.invitedAt,
    respondedAt: a.respondedAt,
    completedAt: a.completedAt,
    project: a.project,
    build: a.build,
    bugsReported: bugsByProject.get(a.project.id) ?? 0,
  }))
}

function discoverableTesterWhere(query: {
  search?: string
  countryCode?: string
  skills?: string[]
}): Prisma.TesterProfileWhereInput {
  return {
    /**
     * Only verified testers are discoverable. An applicant or a rejected
     * account is platform-internal state a client has no business browsing.
     */
    status: TesterStatus.VERIFIED,
    user: { deletedAt: null, status: UserStatus.ACTIVE },
    ...(query.countryCode ? { countryCode: query.countryCode } : {}),
    ...(query.skills?.length
      ? { skills: { some: { skill: { slug: { in: query.skills } } } } }
      : {}),
    /**
     * Search deliberately does NOT match on name or email — that would let a
     * client confirm whether a specific person is on the platform. Headline,
     * profession and skills are what a capability search needs.
     */
    ...(query.search
      ? {
          OR: [
            { headline: { contains: query.search, mode: 'insensitive' } },
            { profession: { contains: query.search, mode: 'insensitive' } },
            {
              skills: {
                some: { skill: { name: { contains: query.search, mode: 'insensitive' } } },
              },
            },
          ],
        }
      : {}),
  }
}

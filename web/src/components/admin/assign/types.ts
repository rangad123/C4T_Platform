import type { BadgeProps } from '@/components/ds/core/Badge'

/** One row of `GET /v1/testers/assignment-candidates`. */
export interface Candidate {
  id: string
  status: string
  headline: string | null
  profession: string | null
  city: string | null
  countryCode: string | null
  experienceYears: number | null
  ratingAverage: string | null
  ratingCount: number
  bugsAcceptedCount: number
  projectsCompletedCount: number
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    avatarFileId: string | null
  }
  skills: readonly { skill: { id: string; name: string; slug: string } }[]
  languages: readonly { code: string; proficiency: string }[]
  devices: readonly {
    id: string
    type: string
    manufacturer: string | null
    model: string | null
    osName: string | null
    osVersion: string | null
  }[]
  browsers: readonly {
    id: string
    browser: { id: string; name: string }
    browserVersion: { id: string; version: string } | null
    operatingSystem: { id: string; name: string } | null
    osVersionRef: {
      id: string
      version: string
      operatingSystem: { id: string; name: string }
    } | null
  }[]
  /**
   * This tester's standing on the target build. Null means never invited to
   * it; ABSENT means the question was not asked — the message composer's
   * recipient search is not build-scoped, so there is no roster to report
   * anyone against and the field never arrives.
   */
  assignment?: {
    id: string
    status: string
    invitedAt: string
    respondedAt: string | null
  } | null
}

export interface CandidateMeta {
  total: number
  page: number
  limit: number
}

export interface Filters {
  search: string
  countryCode: string
  city: string
  status: string
  minRating: string
  osName: string
  browser: string
  skills: string[]
}

export interface FilterOptions {
  countries: readonly { value: string; label: string }[]
  operatingSystems: readonly { value: string; label: string }[]
  browsers: readonly { value: string; label: string }[]
  skillCategories: readonly {
    name: string
    slug: string
    skills: readonly { value: string; label: string }[]
  }[]
}

/**
 * Statuses from which a tester may be invited onto this build again.
 *
 * DECLINED and REMOVED are spent, not live: neither grants the tester any
 * access, and both are excluded from the project's `maxTesters` count. So
 * inviting one again is a real action, and `assignTesters` performs it by
 * reviving the existing row — the unique constraint forbids a second one, so
 * revival is the only shape it can take.
 *
 * Everything else (INVITED, ACCEPTED, ACTIVE, COMPLETED) is a live standing
 * the service deliberately leaves alone, because re-inviting someone already
 * working on the build would reset it for nothing.
 *
 * This set must agree with `REVIVABLE` in `projects.service.ts`. If they
 * drift, the picker either blocks an invitation the API would accept or
 * offers one it will silently skip.
 */
export const ASSIGNABLE_AGAIN = new Set<string>(['DECLINED', 'REMOVED'])

export function personLabel(candidate: Candidate): string {
  const name = [candidate.user.firstName, candidate.user.lastName].filter(Boolean).join(' ').trim()
  return name || candidate.user.email
}

/** How a tester's existing standing on the build should read, if they have one. */
export function describeAssignment(
  assignment: Candidate['assignment'],
): { label: string; tone: BadgeProps['tone']; assignableAgain: boolean } | null {
  if (!assignment) return null
  const assignableAgain = ASSIGNABLE_AGAIN.has(assignment.status)

  /**
   * DECLINED and REMOVED read as neutral rather than green: they are on this
   * build's roster historically, but they are not working on it. Saying
   * "already accepted" for someone who declined would be worse than useless.
   */
  const tone: BadgeProps['tone'] = assignableAgain
    ? 'neutral'
    : assignment.status === 'INVITED'
      ? 'info'
      : 'success'
  /**
   * A revivable standing says so plainly. "Declined" alone would read as a
   * closed door, when selecting them is exactly what re-invites them.
   */
  const label = assignableAgain
    ? `${titleCase(assignment.status)} — re-invite`
    : `Already ${titleCase(assignment.status).toLowerCase()}`
  return { label, tone, assignableAgain }
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
}

/**
 * Tester statuses a message may be addressed to.
 *
 * Offered by the composer and NOT by the assignment picker, deliberately. An
 * applicant or a suspended account can legitimately be written to — "your
 * application needs a device on file" is exactly the message this platform
 * should be able to send — but neither can be put on a build, and
 * `assertAssignable` refuses. A picker that lists people the caller cannot
 * act on is worse than no picker, because it only refuses at the end.
 */
export const RECIPIENT_STATUSES: readonly { value: string; label: string }[] = [
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'APPLIED', label: 'Applied' },
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'SUSPENDED', label: 'Suspended' },
]

const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  RECIPIENT_STATUSES.map((s) => [s.value, s.label]),
)

/** The active filters, as removable chips. */
export function filterChips(
  filters: Filters,
  options: FilterOptions,
): { key: string; label: string; clear: Partial<Filters> }[] {
  const chips: { key: string; label: string; clear: Partial<Filters> }[] = []

  if (filters.search) {
    chips.push({ key: 'search', label: `“${filters.search}”`, clear: { search: '' } })
  }
  if (filters.countryCode) {
    const country = options.countries.find((c) => c.value === filters.countryCode)
    chips.push({
      key: 'country',
      label: country?.label ?? filters.countryCode,
      clear: { countryCode: '' },
    })
  }
  if (filters.city) chips.push({ key: 'city', label: filters.city, clear: { city: '' } })
  /*
    Only ever a chip when it is NOT the default. Verified is what every picker
    opens on, and a permanent "Verified" chip with an x on it would invite
    clearing the one filter that is doing the most useful work.
  */
  if (filters.status && filters.status !== 'VERIFIED') {
    chips.push({
      key: 'status',
      label: STATUS_LABELS[filters.status] ?? filters.status,
      clear: { status: 'VERIFIED' },
    })
  }
  if (filters.osName) chips.push({ key: 'os', label: filters.osName, clear: { osName: '' } })
  if (filters.browser) {
    chips.push({ key: 'browser', label: filters.browser, clear: { browser: '' } })
  }
  if (filters.minRating) {
    chips.push({
      key: 'rating',
      label: `${filters.minRating}+ rating`,
      clear: { minRating: '' },
    })
  }

  const skillLabel = new Map(
    options.skillCategories.flatMap((c) => c.skills.map((s) => [s.value, s.label] as const)),
  )
  for (const slug of filters.skills) {
    chips.push({
      key: `skill:${slug}`,
      label: skillLabel.get(slug) ?? slug,
      clear: { skills: filters.skills.filter((s) => s !== slug) },
    })
  }

  return chips
}

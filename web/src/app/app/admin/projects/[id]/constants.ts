/**
 * Shared shapes and enums for the project detail page.
 *
 * This is deliberately a plain module, NOT a `'use server'` one. Every export of
 * a `'use server'` file must be an async function — exporting a type or a const
 * from `actions.ts` silently unregisters every action in it — so the enums the
 * page and the actions both need live here instead.
 *
 * The unions mirror the Prisma enums in `api/prisma/schema.prisma`. They are
 * restated rather than imported so the two services stay independently
 * deployable, exactly as `lib/api/types.ts` does for Role.
 */

export const PROJECT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'IN_PROGRESS',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const
export type ProjectStatusValue = (typeof PROJECT_STATUSES)[number]

export const PROJECT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type ProjectPriorityValue = (typeof PROJECT_PRIORITIES)[number]

export const ASSIGNMENT_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'DECLINED',
  'ACTIVE',
  'COMPLETED',
  'REMOVED',
] as const
export type AssignmentStatusValue = (typeof ASSIGNMENT_STATUSES)[number]

/**
 * The lifecycle graph, mirroring `STATUS_TRANSITIONS` in
 * `api/src/modules/projects/projects.service.ts`.
 *
 * The API rejects anything outside this map with a 409, so offering the full
 * enum in the status select would hand the admin five options where two are
 * legal. The select is built from this instead, which means an illegal move is
 * unreachable rather than merely refused.
 */
export const STATUS_TRANSITIONS: Readonly<
  Record<ProjectStatusValue, readonly ProjectStatusValue[]>
> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'PAUSED', 'CANCELLED'],
  IN_PROGRESS: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['IN_PROGRESS', 'CANCELLED'],
  // Reopening a finished project is allowed; nothing else is.
  COMPLETED: ['IN_PROGRESS'],
  // Cancelled is terminal.
  CANCELLED: [],
}

/** The moves available from a status the web app may not recognise yet. */
export function allowedTransitions(status: string): readonly ProjectStatusValue[] {
  return isProjectStatus(status) ? STATUS_TRANSITIONS[status] : []
}

export function isProjectStatus(value: string): value is ProjectStatusValue {
  return (PROJECT_STATUSES as readonly string[]).includes(value)
}

export function isProjectPriority(value: string): value is ProjectPriorityValue {
  return (PROJECT_PRIORITIES as readonly string[]).includes(value)
}

export function isAssignmentStatus(value: string): value is AssignmentStatusValue {
  return (ASSIGNMENT_STATUSES as readonly string[]).includes(value)
}

// ─── Response shapes ─────────────────────────────────────────────────────────
// Taken from the `select` in projects.service.ts → getProject().

export interface ProjectPerson {
  id: string
  firstName: string | null
  lastName: string | null
  email: string
}

export interface ProjectMaterial {
  id: string
  title: string
  description: string | null
  url: string | null
  fileId: string | null
  createdAt: string
  file: { id: string; originalName: string; mimeType: string; sizeBytes: number } | null
}

export interface ProjectAssignmentRow {
  status: string
  invitedAt: string
  respondedAt: string | null
  completedAt: string | null
  notes: string | null
  tester: ProjectPerson & {
    testerProfile: {
      id: string
      /** Prisma Decimal — serialises as a string, so never call toFixed on it raw. */
      ratingAverage: string | number | null
      countryCode: string | null
    } | null
  }
}

export interface ProjectManagerRow {
  assignedAt: string
  manager: ProjectPerson & { role: string }
}

export interface ProjectDetail {
  id: string
  reference: string
  title: string
  summary: string | null
  instructions: string | null
  status: string
  priority: string
  platformTargets: string[]
  targetCountries: string[]
  targetLanguages: string[]
  maxTesters: number | null
  testersCanSeeOtherBugs: boolean
  startDate: string | null
  endDate: string | null
  submittedAt: string | null
  approvedAt: string | null
  completedAt: string | null
  progressPercent: number
  createdAt: string
  updatedAt: string
  organisation: { id: string; name: string; slug: string; status: string }
  createdBy: ProjectPerson | null
  _count: { bugs: number; assignments: number; materials: number }
  materials: ProjectMaterial[]
  assignments: ProjectAssignmentRow[]
  managers: ProjectManagerRow[]
  capabilities: {
    canReadBrief: boolean
    canUpdate: boolean
    canChangeStatus: boolean
    canAssignTesters: boolean
    canManageMaterials: boolean
    canReportBug: boolean
    myAssignmentStatus: string | null
  }
}

/** A row from `GET /v1/testers?status=VERIFIED`. */
export interface VerifiedTesterRow {
  /** The tester PROFILE id. Assignments key on `user.id`, not this. */
  id: string
  status: string
  countryCode: string | null
  ratingAverage: string | number | null
  ndaAcceptedAt: string | null
  user: ProjectPerson & { status: string }
  devices: readonly { type: string }[]
}

/**
 * Loose platform-fit check for the invite picker — not enforced by the API,
 * since `platformTargets` is free text with no formal contract with
 * `DeviceType`. This is a hint for the admin, not a hard eligibility gate:
 * a project with no targets, or a tester with no devices listed yet, always
 * reads as "no signal" rather than "ineligible."
 */
export function deviceFitsTargets(
  devices: readonly { type: string }[],
  platformTargets: readonly string[],
): 'match' | 'no-signal' | 'mismatch' {
  if (platformTargets.length === 0 || devices.length === 0) return 'no-signal'

  const wantsMobile = platformTargets.some((t) => /android|ios|mobile/i.test(t))
  const wantsWeb = platformTargets.some((t) => /web|desktop|browser/i.test(t))
  const wantsTablet = platformTargets.some((t) => /tablet/i.test(t))

  if (!wantsMobile && !wantsWeb && !wantsTablet) return 'no-signal'

  const hasMobile = devices.some((d) => d.type === 'MOBILE')
  const hasTablet = devices.some((d) => d.type === 'TABLET')
  const hasDesktop = devices.some((d) => d.type === 'DESKTOP')

  const matches = (wantsMobile && hasMobile) || (wantsWeb && hasDesktop) || (wantsTablet && hasTablet)
  return matches ? 'match' : 'mismatch'
}

/** A row from `GET /v1/bugs?projectId=…`. */
export interface ProjectBugRow {
  id: string
  reference: string
  title: string
  severity: string
  status: string
  createdAt: string
  reportedBy: ProjectPerson | null
}

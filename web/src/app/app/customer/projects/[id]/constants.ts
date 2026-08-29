/**
 * Shared shapes and enums for the customer project detail page.
 *
 * Subset of `admin/projects/[id]/constants.ts` — drops the tester-roster and
 * structured-testing shapes (`VerifiedTesterRow`, `deviceFitsTargets`,
 * `TestCaseRow`, `ASSIGNMENT_STATUSES`) since the customer page has no
 * Testers or Test reports tab. Everything kept is restated rather than
 * imported from the admin route so the two stay independently editable.
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

/** Mirrors `STATUS_TRANSITIONS` in `api/src/modules/projects/projects.service.ts`. */
export const STATUS_TRANSITIONS: Readonly<Record<ProjectStatusValue, readonly ProjectStatusValue[]>> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'PAUSED', 'CANCELLED'],
  IN_PROGRESS: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  CANCELLED: [],
}

export function allowedTransitions(status: string): readonly ProjectStatusValue[] {
  return isProjectStatus(status) ? STATUS_TRANSITIONS[status] : []
}

export function isProjectStatus(value: string): value is ProjectStatusValue {
  return (PROJECT_STATUSES as readonly string[]).includes(value)
}

export function isProjectPriority(value: string): value is ProjectPriorityValue {
  return (PROJECT_PRIORITIES as readonly string[]).includes(value)
}

export interface ProjectPerson {
  id: string
  firstName: string | null
  lastName: string | null
  email: string
}

export interface ProjectMaterial {
  id: string
  buildId: string
  title: string
  description: string | null
  url: string | null
  fileId: string | null
  createdAt: string
  file: { id: string; originalName: string; mimeType: string; sizeBytes: number } | null
}

export interface ProjectAssignmentRow {
  buildId: string
  status: string
  invitedAt: string
  respondedAt: string | null
  completedAt: string | null
  notes: string | null
  tester: {
    id: string
    firstName: string | null
    lastName: string | null
    /**
     * Absent for a customer caller. The API omits tester email addresses for
     * anyone who is not admin-side, so this is genuinely optional here rather
     * than a string the UI has to remember not to render.
     */
    email?: string
    testerProfile: {
      id: string
      /**
       * A Prisma Decimal — JSON serialises it as a STRING, not a number.
       * Typing it as a number is what made `.toFixed()` blow up at runtime
       * with the typecheck perfectly happy.
       */
      ratingAverage: string | null
      countryCode: string | null
    } | null
  }
}

export interface ProjectBuild {
  id: string
  name: string
  isDefault: boolean
  createdAt: string
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
  builds: ProjectBuild[]
  activeBuildId: string
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

export const BUILD_STATUSES = ['NEW', 'ASSIGNED', 'TESTED', 'REVIEWED', 'CLOSED'] as const
export type BuildStatusValue = (typeof BUILD_STATUSES)[number]

export interface BuildDetail {
  id: string
  projectId: string
  name: string
  isDefault: boolean
  status: string
  testType: string | null
  description: string | null
  appUrl: string | null
  releaseNotes: string | null
  instructions: string | null
  specialRequirements: string | null
  targetDevices: string[]
  targetBrowsers: string[]
  targetOperatingSystems: string[]
  targetCountries: string[]
  targetLanguages: string[]
  maxTesters: number | null
  testersCanSeeOtherBugs: boolean | null
  startDate: string | null
  endDate: string | null
  testDocumentFileId: string | null
  /** §36 — whether this build's bug form carries the client's extra fields. */
  bugCustomizationEnabled: boolean
  testDocument: { id: string; originalName: string; mimeType: string; sizeBytes: number } | null
  createdAt: string
  updatedAt: string
  _count: { assignments: number; bugs: number; materials: number; features: number; testCases: number }
  capabilities: { canUpdate: boolean }
}

export interface BuildSummary {
  testerCount: number
  bugCount: number
  bugsBySeverity: Record<string, number>
  bugsByStatus: Record<string, number>
  bugsByType: Record<string, number>
  bugsByReproducibility: Record<string, number>
  testCaseCount: number
  testCaseCompletion: number | null
  testReportsByResult: Record<string, number>
  reviewCount: number
  averageRating: number | null
}

/**
 * `GET /reports/by-project/:id` — reused for the Overview tab's summary
 * panel, same as admin's. `report.generate` includes `project:customer` in
 * policy.ts, so this is reachable.
 */
export interface ProjectReportSummary {
  testerCount: number
  testCaseCount: number
  bugs: {
    total: number
    bySeverity: Record<string, number>
    byStatus: Record<string, number>
    byType: Record<string, number>
  }
  testersByCountry: Record<string, number>
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

/**
 * `GET /v1/reports/by-build/:buildId`.
 *
 * A FLAT shape, deliberately typed as the endpoint actually returns it rather
 * than reshaped to match `by-project`. The two differ — by-project nests
 * counts under `bugs`, this one does not — and pretending otherwise is how a
 * `buildReport.build.name` read ends up undefined at runtime while the
 * typecheck passes.
 */
export interface BuildReport {
  testerCount: number
  bugCount: number
  bugsBySeverity: Record<string, number>
  bugsByStatus: Record<string, number>
  bugsByType: Record<string, number>
  bugsByReproducibility: Record<string, number>
  testCaseCount: number
  testCaseCompletion: number
  reviewCount: number
  /** A Prisma Decimal, so JSON gives a string. Never assume a number. */
  averageRating: string | null
}

/** A row of `GET /v1/communication/announcements`. */
export interface AnnouncementRow {
  id: string
  title: string
  body: string
  audience: string
  projectId: string | null
  buildId: string | null
  build: { id: string; name: string } | null
  publishedAt: string | null
  expiresAt: string | null
  author: { id: string; firstName: string | null; lastName: string | null } | null
}

/** A row of `GET /v1/projects/:id/custom-fields` (§37). */
export interface BugCustomFieldRow {
  id: string
  name: string
  type: string
  options: readonly string[]
  isRequired: boolean
  position: number
  createdAt: string
  /** How many bugs already answered it — the delete warning needs this. */
  _count: { values: number }
}

/** Human labels for `BugFieldType`, so the table does not show enum names. */
export const BUG_FIELD_TYPE_LABEL: Record<string, string> = {
  TEXT: 'Short text',
  TEXTAREA: 'Long text',
  NUMBER: 'Number',
  DATE: 'Date',
  URL: 'Link',
  SELECT: 'Dropdown',
  RADIO: 'Single choice',
  CHECKBOX: 'Multiple choice',
}

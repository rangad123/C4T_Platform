/**
 * Shared shapes for the tester's build workspace.
 *
 * A plain module, not `'use server'` — every export of a `'use server'` file
 * must be an async function, so types and enums live here.
 *
 * These mirror the API's own `select` shapes: `projects.service.ts`'s
 * `getProject`/`buildSelect` and `bugs.service.ts`'s `bugSelect`. They are
 * restated rather than imported so the two services stay independently
 * deployable, matching how `lib/api/types.ts` already treats Role.
 */

export interface Person {
  id: string
  firstName: string | null
  lastName: string | null
  email?: string | null
}

/** One test cycle on a project. */
export interface ProjectBuild {
  id: string
  name: string
  isDefault: boolean
  createdAt: string
}

/**
 * `GET /v1/projects/:id` as a TESTER sees it.
 *
 * The API narrows this for a tester before it ever reaches us:
 * `instructions` is null without `project.read_brief` (an INVITED tester has
 * not accepted yet, so they get the shape of the work but not the script),
 * `materials` is empty for the same reason and filtered to `activeBuildId`
 * otherwise, `managers` is always empty, and `assignments` holds exactly the
 * caller's own row FOR THE ACTIVE BUILD. `activeBuildId` is the build
 * currently selected — a tester can now hold a row on more than one build of
 * this project, and `?buildId=` picks among the ones they actually hold
 * (anything else is ignored server-side, falling back to their most
 * relevant row). `myAssignments` lists every build they hold a row on, for
 * rendering a switcher — see `BuildSwitcher`.
 */
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
  progressPercent: number
  createdAt: string
  updatedAt: string
  organisation: { id: string; name: string; slug: string; status: string }
  _count: { bugs: number; assignments: number; materials: number }
  builds: ProjectBuild[]
  activeBuildId: string
  materials: ProjectMaterial[]
  assignments: readonly {
    buildId: string
    status: string
    invitedAt: string
    respondedAt: string | null
    completedAt: string | null
    notes: string | null
    tester: Person
  }[]
  /** Every build this tester holds a row on — the material for a build switcher. */
  myAssignments: readonly { buildId: string; status: string }[]
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

/**
 * `GET /v1/projects/:id/builds/:buildId` — the "Test details" and "Device
 * details" the tester works from. Gated on `project.read`, so any assigned
 * tester can read it.
 */
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
  testDocument: { id: string; originalName: string; mimeType: string; sizeBytes: number } | null
  createdAt: string
  updatedAt: string
  _count: {
    assignments: number
    bugs: number
    materials: number
    features: number
    testCases: number
  }
}

/** A tag a bug can be filed against, from `GET /v1/projects/:id/features`. */
export interface ProjectFeature {
  id: string
  name: string
  createdAt: string
  _count: { bugs: number }
}

/** A row from `GET /v1/bugs`. */
export interface BugRow {
  id: string
  reference: string
  title: string
  severity: string
  status: string
  type: string | null
  createdAt: string
  feature: { id: string; name: string } | null
  reportedBy: Person | null
  project: { id: string; reference: string; title: string } | null
  _count: { attachments: number; comments: number }
}

export interface AnnouncementRow {
  id: string
  title: string
  body: string
  audience: string
  projectId: string | null
  project: { id: string; reference: string; title: string } | null
  /** Set when the announcement was narrowed to one build of `projectId`. */
  buildId: string | null
  build: { id: string; name: string } | null
  publishedAt: string | null
  expiresAt: string | null
  author: Person | null
}

/**
 * A test case with its reports, as `GET /test-cases?buildId=` returns it.
 *
 * The API scopes by relation, so a plain tester receives only the cases
 * assigned to them — the same endpoint and shape the admin and customer
 * portals read, with different rows.
 */
export interface TestCaseRow {
  id: string
  feature: string | null
  title: string
  description: string
  steps: string
  expectedResult: string
  createdAt: string
  assignments: readonly { id: string; assignedAt: string }[]
  reports: readonly {
    id: string
    result: string
    notes: string | null
    devices: string | null
    browsers: string | null
    createdAt: string
    linkedBug: { id: string; reference: string; title: string } | null
  }[]
  _count: { reports: number }
}

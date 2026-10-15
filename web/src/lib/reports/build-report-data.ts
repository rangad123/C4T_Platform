import 'server-only'
import { serverFetch, serverFetchOrNull, serverFetchPage } from '@/lib/api/server'
import { env } from '@/lib/env'
import { loadBugReport, type BugReport } from '@/lib/reports/bug-report-data'

/**
 * Everything the per-build report workbook is made from, read through the
 * caller's own session — so the API, not this file, decides what a given
 * reader may see. The admin and customer downloads call the same loader and
 * differ only in `audience`, which gates the few columns the customer page
 * itself never shows (a tester's assigned device and browser).
 *
 * ── WHAT IS DELIBERATELY NOT HERE
 *
 * Email and phone. `ReportPerson` does not declare them, so a person can only
 * ever be named, never contacted, from anything built on these types. The
 * admin session does receive `email` on the wire; widening this type is a
 * decision that needs making on purpose (see `report-csv.ts` for why the
 * original export was removed platform-wide on 2026-09-02).
 *
 * Every figure the workbook shows is read from here, never typed in. Where a
 * source could not be read it is `null`, which the workbook renders as
 * "unavailable" — distinct from a real zero.
 */

export type ReportAudience = 'admin' | 'customer'

export interface ReportPerson {
  id: string
  firstName: string | null
  lastName: string | null
}

export interface ReportProject {
  reference: string
  title: string
  summary: string | null
  status: string
  priority: string
  platformTargets: string[]
  targetCountries: string[]
  targetLanguages: string[]
  maxTesters: number | null
  startDate: string | null
  endDate: string | null
  progressPercent: number
  createdAt: string
  organisation: { name: string }
}

export interface ReportBuild {
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
  startDate: string | null
  endDate: string | null
  testDocument: { originalName: string } | null
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

/** `GET /builds/:id/summary` — the API's own aggregates, used as-is for the headline figures. */
export interface ReportSummary {
  testerCount: number
  bugCount: number
  testCaseCount: number
  testCaseCompletion: number | null
  testReportsByResult: Record<string, number>
  reviewCount: number
  averageRating: number | null
}

export interface ReportFeature {
  name: string
  createdAt: string
  _count: { bugs: number }
}

export interface ReportMaterial {
  title: string
  description: string | null
  url: string | null
  createdAt: string
  file: { originalName: string; sizeBytes: number } | null
}

export interface ReportTester {
  status: string
  invitedAt: string
  respondedAt: string | null
  completedAt: string | null
  assignedDevice: {
    type: string
    manufacturer: string | null
    model: string | null
    osName: string | null
  } | null
  assignedBrowser: { browser: { name: string }; browserVersion: { version: string } | null } | null
  tester: ReportPerson & {
    testerProfile: { ratingAverage: string | number | null; countryCode: string | null } | null
  }
}

export interface ReportTestCase {
  id: string
  feature: string | null
  title: string
  expectedResult: string
  createdAt: string
  assignments: readonly { tester: ReportPerson }[]
  reports: readonly {
    id: string
    result: string
    notes: string | null
    devices: string | null
    browsers: string | null
    createdAt: string
    tester: ReportPerson
    linkedBug: { reference: string } | null
  }[]
}

export interface BuildReportData {
  audience: ReportAudience
  generatedAt: Date
  /** Where the portal lives, so the report can link back into it (`https://…`, no trailing slash). */
  siteUrl: string
  project: ReportProject
  build: ReportBuild | null
  summary: ReportSummary | null
  features: readonly ReportFeature[] | null
  testers: readonly ReportTester[]
  materials: readonly ReportMaterial[]
  /** Null when the test cases could not be read — not the same as "none were set up". */
  testCases: readonly ReportTestCase[] | null
  bugReport: BugReport
}

interface ProjectRead extends ReportProject {
  activeBuildId: string
  assignments: ReportTester[]
  materials: ReportMaterial[]
}

/** Every page of the build's test cases (the API caps a page at 100). */
async function loadTestCases(buildId: string): Promise<ReportTestCase[] | null> {
  try {
    const all: ReportTestCase[] = []
    for (let page = 1; ; page += 1) {
      const { data, meta } = await serverFetchPage<ReportTestCase>('test-cases', {
        query: { buildId, page, limit: 100 },
      })
      all.push(...data)
      if (!meta?.hasNext) break
    }
    return all
  } catch {
    return null
  }
}

export async function loadBuildReport(
  audience: ReportAudience,
  projectId: string,
  requestedBuildId: string | undefined,
): Promise<BuildReportData> {
  // The project read resolves the active build (the requested one, or the
  // project's default) before anything build-scoped can be fetched.
  const project = await serverFetch<ProjectRead>(`projects/${projectId}`, {
    query: { buildId: requestedBuildId },
  })
  const buildId = project.activeBuildId

  const [build, summary, features, testCases, bugReport] = await Promise.all([
    serverFetchOrNull<ReportBuild>(`projects/${projectId}/builds/${buildId}`),
    serverFetchOrNull<ReportSummary>(`builds/${buildId}/summary`),
    serverFetchOrNull<readonly ReportFeature[]>(`projects/${projectId}/features`, {
      query: { buildId },
    }),
    loadTestCases(buildId),
    loadBugReport(projectId, buildId),
  ])

  return {
    audience,
    generatedAt: new Date(),
    siteUrl: env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, ''),
    project,
    build,
    summary,
    features,
    testers: project.assignments,
    materials: project.materials,
    testCases,
    bugReport,
  }
}

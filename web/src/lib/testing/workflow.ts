import { ApiError } from '@/lib/api/types'
import type { NoticeCopy } from '@/components/admin/Notice'

/**
 * Shared by the applications, execution-review and timesheet pages.
 *
 * Their Server Actions redirect with `?notice=<code>`; a refusal from the API
 * also carries its own sentence in `?detail=`, because "This project is
 * already at its limit of 5 testers" tells the reader what to do and a
 * generic retry message does not.
 */

/** The API's sentence for a 4xx, or null when it gave none worth showing. */
export function failureDetail(error: unknown): string | null {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return error.message.slice(0, 300)
  }
  return null
}

/** A notice map plus the one dynamic entry: `error`, worded by the API. */
export function workflowNotices(
  fixed: Readonly<Record<string, NoticeCopy>>,
  detail: string | undefined,
): Record<string, NoticeCopy> {
  return {
    ...fixed,
    error: { tone: 'error', message: detail ?? 'That did not go through. Try again in a moment.' },
  }
}

export interface PersonRef {
  id: string
  firstName: string | null
  lastName: string | null
  email?: string
}

export interface ProjectRef {
  id: string
  reference: string
  title: string
}

export interface ApplicationRow {
  id: string
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN'
  message: string | null
  decisionNote: string | null
  decidedAt: string | null
  createdAt: string
  tester: PersonRef
  build: { id: string; name: string }
  project: ProjectRef
}

export interface OpenBuildRow {
  id: string
  name: string
  testType: string | null
  startDate: string | null
  endDate: string | null
  targetDevices: string[]
  targetBrowsers: string[]
  targetCountries: string[]
  project: { id: string; title: string; summary: string | null; platformTargets: string[] }
  myApplication: {
    id: string
    status: ApplicationRow['status']
    decisionNote: string | null
  } | null
  myAssignmentStatus: string | null
}

export interface ExecutionRow {
  id: string
  result: string
  notes: string | null
  devices: string | null
  browsers: string | null
  createdAt: string
  reviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED'
  reviewNote: string | null
  tester: PersonRef
  testCase: { id: string; title: string }
  build: { id: string; name: string; project: ProjectRef }
  linkedBug: { id: string; reference: string; title: string } | null
}

export interface TimesheetRow {
  id: string
  workDate: string
  minutes: number
  description: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  approvedMinutes: number | null
  reviewNote: string | null
  createdAt: string
  tester: PersonRef
  build: { id: string; name: string }
  project: ProjectRef
}

export interface ScenarioRow {
  id: string
  title: string
  description: string | null
  _count: { testCases: number }
}

/** `90` → `1 h 30 min`. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

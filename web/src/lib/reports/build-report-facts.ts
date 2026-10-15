import 'server-only'
import type { BugReportRow } from '@/lib/reports/bug-report-data'
import type { BuildReportData } from '@/lib/reports/build-report-data'
import {
  monthLabel,
  parseDate,
  percent,
  personName,
  plural,
  shortDay,
  formatDay,
  titleCase,
} from '@/lib/reports/xlsx-kit'

/**
 * What the report says, worked out from the data and nothing else.
 *
 * The category lists are fixed (every severity, every status, every
 * reproducibility), so a category nobody used shows as a real `0` rather than
 * vanishing — "none of these" and "not measured" must not look alike. Counts
 * come from the same bug rows the detailed sheet lists, so the analytics and
 * the records cannot disagree.
 */

export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const

/** In the order work moves through them. */
export const STATUS_ORDER = [
  'NEW',
  'TRIAGED',
  'CONFIRMED',
  'IN_PROGRESS',
  'REOPENED',
  'FIXED',
  'VERIFIED',
  'REJECTED',
  'DUPLICATE',
  'WONT_FIX',
  'FEATURE_REQUEST',
] as const

export const TYPE_ORDER = [
  'CRASH',
  'APP_FREEZE',
  'FUNCTIONAL',
  'UI',
  'UX',
  'SECURITY',
  'PERFORMANCE',
] as const

export const REPRODUCIBILITY_ORDER = [
  'ALWAYS',
  'SOMETIMES',
  'RARELY',
  'ONCE',
  'UNABLE_TO_REPRODUCE',
] as const

export const RESULT_ORDER = ['PASS', 'FAIL', 'BLOCKED', 'NOT_TESTED'] as const

/** Still needs the delivery team's attention. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set([
  'NEW',
  'TRIAGED',
  'CONFIRMED',
  'IN_PROGRESS',
  'REOPENED',
])
/** Fixed, and either checked or waiting to be. */
export const DONE_STATUSES: ReadonlySet<string> = new Set(['FIXED', 'VERIFIED'])

export interface Count {
  key: string
  label: string
  value: number
}

export interface TrendPoint {
  label: string
  value: number
}

export interface ReportFacts {
  bugs: readonly BugReportRow[]
  total: number
  bySeverity: Count[]
  byStatus: Count[]
  byType: Count[]
  byReproducibility: Count[]
  byFeature: Count[]
  trend: { unit: 'day' | 'week' | 'month'; points: TrendPoint[] }
  open: number
  done: number
  criticalAndHigh: number
  openCritical: number
  duplicatesAndRejected: number
  attachments: number
  reporters: number
  firstReported: Date | null
  lastReported: Date | null
  findings: string[]
}

const naturalReference = (a: BugReportRow, b: BugReportRow): number =>
  a.reference.localeCompare(b.reference, 'en', { numeric: true })

function tally(
  rows: readonly BugReportRow[],
  pick: (row: BugReportRow) => string | null,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = pick(row)
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** Every listed category, then anything the platform sent that the list did not expect. */
function ordered(counts: Map<string, number>, order: readonly string[]): Count[] {
  const known = order.map((key) => ({ key, label: titleCase(key), value: counts.get(key) ?? 0 }))
  const extra = [...counts.keys()]
    .filter((key) => !order.includes(key))
    .sort()
    .map((key) => ({ key, label: titleCase(key), value: counts.get(key) ?? 0 }))
  return [...known, ...extra]
}

const DAY = 86_400_000

/** Bugs per day for a short test, per week for a longer one, per month beyond that. */
function trendOf(rows: readonly BugReportRow[]): ReportFacts['trend'] {
  const dates = rows.map((r) => parseDate(r.createdAt)).filter((d): d is Date => d !== null)
  if (dates.length === 0) return { unit: 'day', points: [] }

  const min = Math.min(...dates.map((d) => d.getTime()))
  const max = Math.max(...dates.map((d) => d.getTime()))
  const spanDays = (max - min) / DAY
  const unit = spanDays <= 31 ? 'day' : spanDays <= 180 ? 'week' : 'month'

  const startOf = (time: number): number => {
    const d = new Date(time)
    if (unit === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    if (unit === 'week') {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      const sinceMonday = (d.getUTCDay() + 6) % 7
      return day - sinceMonday * DAY
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  }
  const next = (time: number): number => {
    if (unit === 'day') return time + DAY
    if (unit === 'week') return time + 7 * DAY
    const d = new Date(time)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }

  const buckets = new Map<number, number>()
  for (const date of dates) {
    const key = startOf(date.getTime())
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }

  // Every period between the first and the last, so a quiet day is a real 0.
  const points: TrendPoint[] = []
  for (let t = startOf(min); t <= startOf(max); t = next(t)) {
    const when = new Date(t)
    const label =
      unit === 'month'
        ? monthLabel(when)
        : unit === 'week'
          ? `Week of ${shortDay(when)}`
          : shortDay(when)
    points.push({ label, value: buckets.get(t) ?? 0 })
  }
  return { unit, points }
}

function top(counts: readonly Count[]): Count | null {
  const best = [...counts].sort((a, b) => b.value - a.value)[0]
  return best && best.value > 0 ? best : null
}

export function computeFacts(data: BuildReportData): ReportFacts {
  const bugs = [...data.bugReport.bugs].sort(naturalReference)
  const total = bugs.length

  const bySeverity = ordered(
    tally(bugs, (b) => b.severity),
    SEVERITY_ORDER,
  )
  const byStatus = ordered(
    tally(bugs, (b) => b.status),
    STATUS_ORDER,
  )
  const typeCounts = tally(bugs, (b) => b.type ?? 'NOT_SPECIFIED')
  const byType = ordered(typeCounts, [...TYPE_ORDER, 'NOT_SPECIFIED']).map((c) =>
    c.key === 'NOT_SPECIFIED' ? { ...c, label: 'Not specified' } : c,
  )
  const byReproducibility = ordered(
    tally(bugs, (b) => b.reproducibility),
    REPRODUCIBILITY_ORDER,
  )

  const featureCounts = tally(bugs, (b) => b.feature?.name ?? 'No feature set')
  const byFeature: Count[] = [...featureCounts]
    .map(([key, value]) => ({ key, label: key, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))

  const count = (set: ReadonlySet<string>) => bugs.filter((b) => set.has(b.status)).length
  const severityOf = (key: string) => bySeverity.find((c) => c.key === key)?.value ?? 0
  const open = count(OPEN_STATUSES)
  const done = count(DONE_STATUSES)
  const criticalAndHigh = severityOf('CRITICAL') + severityOf('HIGH')
  const openCritical = bugs.filter(
    (b) => b.severity === 'CRITICAL' && OPEN_STATUSES.has(b.status),
  ).length
  const duplicatesAndRejected = bugs.filter(
    (b) => b.status === 'DUPLICATE' || b.status === 'REJECTED',
  ).length
  const attachments = bugs.reduce((sum, b) => sum + b._count.attachments, 0)
  const reporterNames = new Set(
    bugs.map((b) => personName(b.reportedBy)).filter((n) => n !== '—' && n !== 'Unknown'),
  )

  const dates = bugs.map((b) => parseDate(b.createdAt)).filter((d): d is Date => d !== null)
  const firstReported =
    dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null
  const lastReported =
    dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null

  const facts: ReportFacts = {
    bugs,
    total,
    bySeverity,
    byStatus,
    byType,
    byReproducibility,
    byFeature,
    trend: trendOf(bugs),
    open,
    done,
    criticalAndHigh,
    openCritical,
    duplicatesAndRejected,
    attachments,
    reporters: reporterNames.size,
    firstReported,
    lastReported,
    findings: [],
  }
  facts.findings = findingsOf(data, facts)
  return facts
}

/** Plain statements of what the numbers show, each one traceable to a figure in the workbook. */
function findingsOf(data: BuildReportData, f: ReportFacts): string[] {
  const out: string[] = []
  const buildName = data.build?.name ?? 'this build'

  if (f.total === 0) {
    out.push(`No bugs have been reported on ${buildName} yet.`)
  } else {
    const by = f.reporters > 0 ? ` by ${plural(f.reporters, 'tester')}` : ''
    out.push(
      `${plural(f.total, 'bug')} ${f.total === 1 ? 'was' : 'were'} reported on ${buildName}${by}.`,
    )

    const share = Math.round(percent(f.criticalAndHigh, f.total) * 100)
    out.push(
      `${f.criticalAndHigh} of ${f.total} bugs (${share}%) are critical or high severity.` +
        (f.openCritical > 0
          ? ` ${plural(f.openCritical, 'critical bug')} ${f.openCritical === 1 ? 'is' : 'are'} still open.`
          : ' No critical bug is still open.'),
    )

    out.push(
      `${f.open} ${f.open === 1 ? 'bug is' : 'bugs are'} open and ${f.done} ${f.done === 1 ? 'is' : 'are'} fixed or verified.`,
    )

    const type = top(f.byType.filter((c) => c.key !== 'NOT_SPECIFIED'))
    if (type)
      out.push(
        `The most common type is ${type.label.toLowerCase()} (${plural(type.value, 'bug')}).`,
      )

    const feature = top(f.byFeature.filter((c) => c.key !== 'No feature set'))
    if (feature) out.push(`${feature.label} has the most bugs of any feature (${feature.value}).`)

    const always = f.byReproducibility.find((c) => c.key === 'ALWAYS')?.value ?? 0
    if (always > 0) {
      out.push(`${Math.round(percent(always, f.total) * 100)}% of bugs reproduce every time.`)
    }

    if (f.firstReported && f.lastReported) {
      out.push(
        f.firstReported.getTime() === f.lastReported.getTime()
          ? `Bugs were reported on ${formatDay(f.firstReported)}.`
          : `Bugs were reported between ${formatDay(f.firstReported)} and ${formatDay(f.lastReported)}.`,
      )
    }
  }

  const { summary } = data
  if (summary && summary.testCaseCount > 0) {
    out.push(
      summary.testCaseCompletion === null
        ? `${plural(summary.testCaseCount, 'test case')} ${summary.testCaseCount === 1 ? 'was' : 'were'} set up for this build.`
        : `${plural(summary.testCaseCount, 'test case')}, with completion at ${summary.testCaseCompletion}%.`,
    )
  } else {
    out.push('No test cases were set up for this build, so there are no test results.')
  }
  if (summary?.averageRating !== null && summary?.averageRating !== undefined) {
    out.push(
      `Reviews average ${summary.averageRating.toFixed(1)} out of 5 across ${plural(summary.reviewCount, 'review')}.`,
    )
  }
  return out
}

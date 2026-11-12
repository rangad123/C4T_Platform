import { Panel } from '@/components/admin/Panel'
import { BarChart } from '@/components/admin/charts/BarChart'
import { severityTone, statusTone } from '@/components/admin/StatusBadge'
import { formatDate, personName, titleCase } from '@/lib/admin/format'
import { BUG_SEVERITIES, BUG_STATUSES } from '@/lib/domain/enums'

/** `GET /reports/by-project/:projectId/bug-analytics`. */
export interface ProjectBugAnalyticsData {
  total: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  byBuild: readonly { id: string; name: string; count: number }[]
  byTester: readonly {
    id: string
    firstName: string | null
    lastName: string | null
    count: number
  }[]
  overTime: { bucket: 'week' | 'month'; points: readonly { start: string; count: number }[] }
}

const TOP_TESTERS = 10

function bucketLabel(start: string, bucket: 'week' | 'month'): string {
  if (bucket === 'week') return `Week of ${formatDate(start)}`
  return new Date(start).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Bugs across every build of one project, cut five ways. Shared by the admin
 * and customer project dashboards; the API decides what each may count.
 * Severity and status keep their lifecycle order, the rest sort by count.
 */
export function ProjectBugAnalytics({ data }: { data: ProjectBugAnalyticsData | null }) {
  const muted = (text: string) => (
    <p className="c4t-body-sm" style={{ margin: 0, color: 'var(--text-secondary)' }}>
      {text}
    </p>
  )

  const testers = data?.byTester.slice(0, TOP_TESTERS) ?? []
  const others = (data?.byTester.length ?? 0) - testers.length

  return (
    <Panel title="Bug analytics" description="Every bug on this project, across all builds.">
      {!data ? (
        muted('These analytics could not be loaded. Refresh in a moment.')
      ) : data.total === 0 ? (
        muted('No bugs have been reported on this project yet.')
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <BarChart
            title="By severity"
            segments={BUG_SEVERITIES.filter((s) => data.bySeverity[s]).map((s) => ({
              label: titleCase(s),
              value: data.bySeverity[s] ?? 0,
              tone: severityTone(s),
            }))}
          />
          <BarChart
            title="By status"
            segments={BUG_STATUSES.filter((s) => data.byStatus[s]).map((s) => ({
              label: titleCase(s),
              value: data.byStatus[s] ?? 0,
              tone: statusTone(s),
            }))}
          />
          <BarChart
            title="By build"
            segments={data.byBuild.map((b) => ({
              label: b.name || 'Unnamed build',
              value: b.count,
              tone: 'neutral' as const,
            }))}
          />
          <BarChart
            title={others > 0 ? `By tester, top ${TOP_TESTERS}` : 'By tester'}
            segments={testers.map((t) => ({
              label: personName(t),
              value: t.count,
              tone: 'neutral' as const,
            }))}
          />
          {others > 0
            ? muted(`${others} more tester${others === 1 ? '' : 's'} reported bugs here.`)
            : null}
          <BarChart
            title={data.overTime.bucket === 'week' ? 'Reported per week' : 'Reported per month'}
            segments={data.overTime.points.map((p) => ({
              label: bucketLabel(p.start, data.overTime.bucket),
              value: p.count,
              tone: 'neutral' as const,
            }))}
          />
        </div>
      )}
    </Panel>
  )
}

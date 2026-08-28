import { Button } from '@/components/ds/core/Button'
import { BarChart } from '@/components/admin/charts/BarChart'
import { statusTone, severityTone } from '@/components/admin/StatusBadge'
import { titleCase } from '@/lib/admin/format'

export interface BugBreakdown {
  total: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  byType: Record<string, number>
  byReproducibility: Record<string, number>
}

export interface BugBreakdownViewProps {
  bugs: BugBreakdown
  /** Same-origin CSV link. Each portal proxies through its own export route. */
  csvHref: string
}

/**
 * The four bug distributions a report answers with, plus its CSV link.
 *
 * Shared by the admin and customer Reports pages rather than copied: the
 * report shapes come from the same `/v1/reports/*` routes, so two renderers
 * would only differ by drift. `severity` and `status` get real tones; `type`
 * and `reproducibility` are open vocabularies with no tone mapping, so they
 * render neutral.
 */
export function BugBreakdownView({ bugs, csvHref }: BugBreakdownViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          {bugs.total} bug{bugs.total === 1 ? '' : 's'} in this report.
        </p>
        {/*
          `prefetch={false}` is load-bearing: this href generates a CSV on the
          API, and Next would otherwise run it on hover.
        */}
        <Button href={csvHref} prefetch={false} variant="secondary" size="sm" iconLeft="download">
          Download CSV
        </Button>
      </div>

      {bugs.total === 0 ? (
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
          Nothing was reported in this range, so there is no distribution to chart.
        </p>
      ) : (
        <>
          <BarChart
            title="By severity"
            segments={Object.entries(bugs.bySeverity).map(([label, value]) => ({
              label: titleCase(label),
              value,
              tone: severityTone(label),
            }))}
          />
          <BarChart
            title="By status"
            segments={Object.entries(bugs.byStatus).map(([label, value]) => ({
              label: titleCase(label),
              value,
              tone: statusTone(label),
            }))}
          />
          <BarChart
            title="By type"
            /* `type` and `reproducibility` are open vocabularies with no
               tone mapping, so they render neutral rather than borrowing a
               severity colour that would imply a meaning they do not have. */
            segments={Object.entries(bugs.byType).map(([label, value]) => ({
              label: titleCase(label),
              value,
              tone: 'neutral' as const,
            }))}
          />
          <BarChart
            title="By reproducibility"
            segments={Object.entries(bugs.byReproducibility).map(([label, value]) => ({
              label: titleCase(label),
              value,
              tone: 'neutral' as const,
            }))}
          />
        </>
      )}
    </div>
  )
}

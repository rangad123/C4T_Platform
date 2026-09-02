import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Topbar } from '@/components/admin/Topbar'
import { KpiCard } from '@/components/admin/KpiCard'
import { BarChart, type BarSegment } from '@/components/admin/charts/BarChart'
import { DonutChart } from '@/components/admin/charts/DonutChart'
import { statusTone, severityTone } from '@/components/admin/StatusBadge'
import { titleCase, formatMoney } from '@/lib/admin/format'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'

/**
 * The admin landing — where ADMIN and SUB_ADMIN arrive after sign-in.
 *
 * One fetch, real numbers. Every figure on this page comes from
 * `GET /v1/stats/admin` (`api/src/modules/stats/stats.routes.ts`), which
 * already existed and already aggregated projects/bugs/testers/orgs/users —
 * this pass only added a `leads` block (reusing the exact groupBy the old
 * version of this page ran as four separate `GET /leads?limit=1` calls) and
 * a `payouts.byCategory` block (reusing the Indian/International/Pending
 * `categoryFilter` the Transactions module already built). Nothing here is
 * mocked or hardcoded — a zero on this page is a real zero.
 *
 * `leads` is `null`, not a row of zeros, when the caller lacks `lead.read` —
 * the API omits it deliberately (see the route's own comment) so a
 * permission gap never reads as "no leads exist".
 */

interface StatsResponse {
  projects: { byStatus: Record<string, number>; newLast30Days: number }
  bugs: {
    byStatus: Record<string, number>
    bySeverity: Record<string, number>
    openCritical: number
    newLast30Days: number
  }
  testers: { byStatus: Record<string, number> }
  organisations: { byStatus: Record<string, number> }
  users: { byRole: Record<string, number> }
  leads: Record<string, number> | null
  finance: { currency: string; collectedMinor: string; paidOutMinor: string }
  payouts: {
    currency: string
    byCategory: { indian: string; international: string; pending: string }
  }
}

function segmentsFromCounts(
  counts: Record<string, number>,
  tone: (key: string) => string,
): BarSegment[] {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({
      label: titleCase(key),
      value,
      tone: tone(key) as BarSegment['tone'],
    }))
}

/**
 * One plain-English line summarising what actually needs a look today —
 * every number below already says this, but not everyone reads a grid of
 * tiles fluently. Priority order is urgency, not the tiles' own layout order:
 * a critical bug outranks a new lead.
 */
function buildNarrative(stats: StatsResponse, newLeads: number): string {
  const notes: string[] = []
  if (stats.bugs.openCritical > 0) {
    notes.push(
      `${stats.bugs.openCritical} open critical bug${stats.bugs.openCritical === 1 ? '' : 's'}`,
    )
  }
  if (stats.leads && newLeads > 0) {
    notes.push(`${newLeads} new lead${newLeads === 1 ? '' : 's'} waiting for a response`)
  }
  if (BigInt(stats.payouts.byCategory.pending) > 0n) {
    notes.push('tester payouts pending')
  }
  if (notes.length === 0) {
    return 'Nothing urgent right now — no critical bugs, no leads waiting, and no payouts pending.'
  }
  return `Needs attention: ${notes.join(', ')}.`
}

function ChartCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 'var(--space-5)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      {children}
    </div>
  )
}

/**
 * A Google sign-in that found an existing account of a different kind. One
 * email is one account, so the role chosen at sign-up cannot override the
 * role that account already has — said here rather than left to guess.
 */
const NOTICES: Record<string, NoticeCopy> = {
  'google-existing-account': {
    tone: 'info',
    message:
      'You already had an account with that Google address, so we signed you into it rather than making a second one.',
  },
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>
}) {
  const { notice } = await searchParams
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])
  const stats = await serverFetchOrNull<StatsResponse>('stats/admin')
  const displayName = user.firstName ?? user.email

  if (!stats) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Dashboard' }]} />
        <main id="main" style={{ padding: 'var(--space-9)', maxWidth: 720 }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            The dashboard summary is unreachable right now. Refresh in a moment, or ask an
            administrator to grant you the stats.read permission.
          </p>
        </main>
      </>
    )
  }

  const activeProjects = stats.projects.byStatus.IN_PROGRESS ?? 0
  const verifiedTesters = stats.testers.byStatus.VERIFIED ?? 0
  const newLeads = stats.leads?.NEW ?? 0
  const narrative = buildNarrative(stats, newLeads)

  // BigInt, not Number: these are minor-unit strings and a float sum risks
  // precision loss above 2^53 — same care `formatMoney` itself takes.
  const payoutTotalMinor = (
    BigInt(stats.payouts.byCategory.indian) +
    BigInt(stats.payouts.byCategory.international) +
    BigInt(stats.payouts.byCategory.pending)
  ).toString()

  return (
    <>
      <Topbar crumbs={[{ label: 'Dashboard' }]} />
      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          maxWidth: 1200,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-8)',
        }}
      >
        <Notice code={notice} notices={NOTICES} />

        <header>
          <p
            className="c4t-eyebrow"
            style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}
          >
            Admin
          </p>
          <h1 className="c4t-display-md" style={{ marginBottom: 'var(--space-2)' }}>
            Welcome back, {displayName}
          </h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: 640 }}>
            A glimpse of the platform — every number links through to the filtered list behind it.
          </p>
          <p
            style={{
              margin: 'var(--space-3) 0 0',
              color: 'var(--text-primary)',
              fontWeight: 'var(--fw-medium)',
              maxWidth: 640,
            }}
          >
            {narrative}
          </p>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-5)',
          }}
        >
          <KpiCard
            icon="briefcase"
            label="Projects in progress"
            value={activeProjects}
            href="/app/admin/projects?status=IN_PROGRESS"
          />
          <KpiCard
            icon="user-check"
            label="Verified testers"
            value={verifiedTesters}
            href="/app/admin/testers?status=VERIFIED"
          />
          <KpiCard
            icon="clock"
            label="Pending tester payouts"
            value={formatMoney(stats.payouts.byCategory.pending, stats.payouts.currency)}
            href="/app/admin/transactions?section=pending"
          />
          {stats.leads ? (
            <KpiCard
              icon="mail"
              label="New leads"
              value={newLeads}
              href="/app/admin/leads?status=NEW"
            />
          ) : null}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'var(--space-5)',
          }}
        >
          <ChartCard>
            <BarChart
              title="Projects by status"
              href="/app/admin/projects"
              segments={segmentsFromCounts(stats.projects.byStatus, statusTone)}
            />
          </ChartCard>

          <ChartCard>
            <DonutChart
              title="Bugs by severity"
              centerLabel={String(Object.values(stats.bugs.bySeverity).reduce((a, b) => a + b, 0))}
              segments={segmentsFromCounts(stats.bugs.bySeverity, severityTone)}
            />
          </ChartCard>

          <ChartCard>
            <BarChart
              title="Bugs by status"
              href="/app/admin/bugs"
              segments={segmentsFromCounts(stats.bugs.byStatus, statusTone)}
            />
          </ChartCard>

          <ChartCard>
            <BarChart
              title="Testers by status"
              href="/app/admin/testers"
              segments={segmentsFromCounts(stats.testers.byStatus, statusTone)}
            />
          </ChartCard>

          <ChartCard>
            <BarChart
              title="Organisations by status"
              href="/app/admin/organisations"
              segments={segmentsFromCounts(stats.organisations.byStatus, statusTone)}
            />
          </ChartCard>

          {stats.leads ? (
            <ChartCard>
              <BarChart
                title="Pipeline by stage"
                href="/app/admin/leads"
                segments={segmentsFromCounts(stats.leads, statusTone)}
              />
            </ChartCard>
          ) : null}

          <ChartCard>
            <DonutChart
              title="Tester payouts by category"
              href="/app/admin/transactions"
              centerLabel={formatMoney(payoutTotalMinor, stats.payouts.currency)}
              segments={(
                [
                  { key: 'indian', label: 'Indian', tone: 'info' },
                  { key: 'international', label: 'International', tone: 'accent' },
                  { key: 'pending', label: 'Pending', tone: 'warning' },
                ] as const
              ).map(({ key, label, tone }) => ({
                label,
                tone,
                value: Number(stats.payouts.byCategory[key]),
                displayValue: formatMoney(stats.payouts.byCategory[key], stats.payouts.currency),
              }))}
            />
          </ChartCard>
        </div>
      </main>
    </>
  )
}

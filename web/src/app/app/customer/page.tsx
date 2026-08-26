import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Topbar } from '@/components/admin/Topbar'
import { KpiCard } from '@/components/admin/KpiCard'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'

const ROOT = { label: 'Customer', href: '/app/customer' }

/** Not yet in a terminal state — the set a customer would call "open". */
const OPEN_BUG_STATUSES = new Set(['NEW', 'TRIAGED', 'CONFIRMED', 'IN_PROGRESS', 'REOPENED'])

interface ProjectRow {
  id: string
  status: string
}

interface BugRow {
  id: string
  status: string
  severity: string
}

interface MyOrganisation {
  id: string
  name: string
  status: string
}

/**
 * `/app/customer` — the customer landing.
 *
 * No dedicated stats endpoint exists for this role (the admin-side one at
 * `stats.routes.ts` is admin-only), so this composes two of the same
 * org-scoped list reads the Projects/Bugs pages themselves use
 * (`GET /projects`, `GET /bugs` — both already filtered to "my organisation"
 * server-side by `projectScope`/`bugScope`) and reduces them to counts here,
 * rather than adding a second aggregation endpoint for one dashboard.
 *
 * Deliberately no financial KPI: the only per-caller money endpoint,
 * `transactions/summary/mine`, is a TESTER earnings aggregate
 * (`counterpartyId: caller`, earnings/payouts only) — wrong for a customer,
 * and would silently read ₹0 regardless of reality. The correct org-scoped
 * `/transactions` list has no page to link through to yet (Transactions is
 * still a "coming soon" sidebar entry), so it is left out rather than shown
 * as a number that goes nowhere.
 */
export default async function CustomerDashboardPage() {
  const user = await requireRole(['CUSTOMER'])

  const [projects, bugs, organisations] = await Promise.all([
    serverFetchOrNull<ProjectRow[]>('projects?limit=100'),
    serverFetchOrNull<BugRow[]>('bugs?limit=100'),
    serverFetchOrNull<readonly MyOrganisation[]>('organisations/mine'),
  ])

  const projectRows = projects ?? []
  const bugRows = bugs ?? []
  const organisation = organisations?.[0]

  const inProgressCount = projectRows.filter((p) => p.status === 'IN_PROGRESS').length
  const openBugCount = bugRows.filter((b) => OPEN_BUG_STATUSES.has(b.status)).length
  const criticalOpenCount = bugRows.filter(
    (b) => b.severity === 'CRITICAL' && OPEN_BUG_STATUSES.has(b.status),
  ).length

  return (
    <>
      <Topbar root={ROOT} crumbs={[{ label: 'Dashboard' }]} />
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
        <header>
          <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}>
            Customer
          </p>
          <h1 className="c4t-display-md" style={{ marginBottom: 'var(--space-2)' }}>
            Welcome back{user.firstName ? `, ${user.firstName}` : ''}
          </h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: 640 }}>
            A glimpse of your projects and bugs — every number links through to the filtered list
            behind it.
          </p>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-5)',
          }}
        >
          <KpiCard icon="briefcase" label="Projects" value={projectRows.length} href="/app/customer/projects" />
          <KpiCard
            icon="clock"
            label="In progress"
            value={inProgressCount}
            href="/app/customer/projects?status=IN_PROGRESS"
          />
          <KpiCard icon="clipboard-check" label="Open bugs" value={openBugCount} href="/app/customer/bugs" />
          <KpiCard
            icon="alert-triangle"
            label="Critical bugs"
            value={criticalOpenCount}
            href="/app/customer/bugs?severity=CRITICAL"
          />
        </div>

        {organisation ? (
          <Panel title="Your organisation">
            <DescriptionList
              items={[
                { label: 'Name', value: organisation.name },
                { label: 'Status', value: organisation.status },
              ]}
            />
          </Panel>
        ) : null}
      </main>
    </>
  )
}

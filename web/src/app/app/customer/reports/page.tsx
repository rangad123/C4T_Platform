import { requireRole } from '@/lib/auth/session'
import { Topbar } from '@/components/admin/Topbar'
import { AdminSectionNotReady } from '@/components/admin/AdminSectionNotReady'

const ROOT = { label: 'Customer', href: '/app/customer' }

/**
 * `/app/customer/reports` — linked from the sidebar, not built yet.
 * The API already supports it (`GET /reports/by-project`, `/by-build`,
 * `/by-build-range` all include `project:customer` in policy.ts) — this is
 * a UI gap, not a backend one.
 */
export default async function CustomerReportsPage() {
  await requireRole(['CUSTOMER'])

  return (
    <>
      <Topbar root={ROOT} crumbs={[{ label: 'Reports' }]} />
      <AdminSectionNotReady
        section="Insights"
        icon="line-chart"
        homeHref="/app/customer"
        description="Report views by project, by build and across a build range — the same aggregations the project page's summary panel already uses, laid out for closer reading and CSV export."
      />
    </>
  )
}

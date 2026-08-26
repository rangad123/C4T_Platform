import { requireRole } from '@/lib/auth/session'
import { Topbar } from '@/components/admin/Topbar'
import { AdminSectionNotReady } from '@/components/admin/AdminSectionNotReady'

const ROOT = { label: 'Customer', href: '/app/customer' }

/**
 * `/app/customer/ratings` — linked from the sidebar, not built yet. The API
 * already supports rating a tester you worked with (`POST /ratings`, with
 * `assertWorkedTogether` verifying org membership and a completed/active
 * assignment) — this is a UI gap, not a backend one.
 */
export default async function CustomerRatingsPage() {
  await requireRole(['CUSTOMER'])

  return (
    <>
      <Topbar root={ROOT} crumbs={[{ label: 'Ratings' }]} />
      <AdminSectionNotReady
        section="Insights"
        icon="star"
        homeHref="/app/customer"
        description="Rate the testers who worked on your projects, and see the ratings your organisation has left."
      />
    </>
  )
}

import { requireRole } from '@/lib/auth/session'
import { Topbar } from '@/components/admin/Topbar'
import { AdminSectionNotReady } from '@/components/admin/AdminSectionNotReady'

const ROOT = { label: 'Customer', href: '/app/customer' }

/**
 * `/app/customer/communication` — linked from the sidebar, not built yet.
 * Threads are already participant-scoped and reachable, and announcements
 * are already role-aware (`[Role.CUSTOMER]: [ALL, CUSTOMERS]` in the API's
 * audience filter) — this is a UI gap, not a backend one.
 */
export default async function CustomerCommunicationPage() {
  await requireRole(['CUSTOMER'])

  return (
    <>
      <Topbar root={ROOT} crumbs={[{ label: 'Communication' }]} />
      <AdminSectionNotReady
        section="Operations"
        icon="message-square"
        homeHref="/app/customer"
        description="Threads with the team on your projects, and announcements from the platform."
      />
    </>
  )
}

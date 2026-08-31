import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/session'
import { Sidebar, type SidebarSection } from '@/components/admin/Sidebar'
import { AppShell } from '@/components/admin/AppShell'

export const metadata: Metadata = {
  title: 'Customer',
  robots: { index: false, follow: false },
}

/**
 * The customer area — `/app/customer/*`.
 *
 * Same shell as `admin/layout.tsx` and `tester/layout.tsx`: gates the route
 * to CUSTOMER, then mounts the sidebar. Reports/Ratings/Transactions/
 * Communication are real, ownership-scoped API surface (see `scopes.ts`/
 * `policy.ts`) but don't have pages yet — they show as disabled "coming
 * soon" links via `Sidebar`'s existing mechanism, rather than being silently
 * missing from the nav.
 */

const CUSTOMER_SECTIONS: readonly SidebarSection[] = [
  {
    links: [{ href: '/app/customer', label: 'Dashboard', icon: 'layout-dashboard' }],
  },
  {
    label: 'Delivery',
    links: [
      { href: '/app/customer/projects', label: 'Projects', icon: 'briefcase' },
      { href: '/app/customer/crowdtesters', label: 'Crowdtesters', icon: 'users' },
    ],
  },
  {
    label: 'Insights',
    links: [{ href: '/app/customer/reports', label: 'Reports', icon: 'line-chart' }],
  },
  {
    label: 'Operations',
    links: [
      { href: '/app/customer/communication', label: 'Communication', icon: 'message-square' },
    ],
  },
  {
    label: 'Account',
    links: [
      { href: '/app/customer/organisation', label: 'Organisation', icon: 'building-2' },
      { href: '/app/customer/profile', label: 'Your profile', icon: 'user-check' },
    ],
  },
]

export default async function CustomerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole(['CUSTOMER'])

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email

  return (
    <AppShell
      nav={
        <Sidebar
          userName={displayName}
          avatarFileId={user.avatarFileId}
          role={user.role}
          sections={CUSTOMER_SECTIONS}
          homeHref="/app/customer"
          portalLabel="Customer"
        />
      }
    >
      {children}
    </AppShell>
  )
}

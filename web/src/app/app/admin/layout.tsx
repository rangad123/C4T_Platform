import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requireRole } from '@/lib/auth/session'
import { Sidebar, type SidebarSection } from '@/components/admin/Sidebar'

export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
}

/**
 * The admin area — `/app/admin/*`.
 *
 * Gates the route to ADMIN and SUB_ADMIN, then mounts the sidebar + topbar
 * shell. Every page below inherits the same chrome.
 *
 * `headers()` is read to derive the current pathname for the sidebar's
 * active-link highlight. The marketing site does this in the client TopNav
 * via `usePathname`; here we are Server Components, so headers is the
 * equivalent without crossing the boundary.
 */

const SECTIONS: readonly SidebarSection[] = [
  {
    label: 'Pipeline',
    links: [
      { href: '/app/admin', label: 'Dashboard', icon: 'layout-dashboard' },
      { href: '/app/admin/leads', label: 'Leads', icon: 'mail' },
    ],
  },
  /**
   * Grouped by what an admin is actually doing, not by API module. The group
   * label is repeated as the eyebrow on each page, so a reader always knows
   * which part of the panel they are in — keep the two in step when adding a
   * page.
   */
  {
    label: 'Accounts',
    links: [
      { href: '/app/admin/organisations', label: 'Organisations', icon: 'building-2' },
      { href: '/app/admin/users', label: 'Users', icon: 'user-check' },
      { href: '/app/admin/testers', label: 'Testers', icon: 'users' },
      { href: '/app/admin/managers', label: 'Managers', icon: 'shield-check' },
      { href: '/app/admin/skills', label: 'Skills', icon: 'briefcase' },
      { href: '/app/admin/assets/devices', label: 'Devices', icon: 'smartphone' },
      { href: '/app/admin/assets/browsers', label: 'Browsers', icon: 'monitor' },
    ],
  },
  {
    /**
     * Bugs and Ratings are not top-level sidebar entries — they live as
     * sub-sections inside the project and tester detail pages respectively.
     * The dedicated /app/admin/bugs and /app/admin/ratings routes stay so
     * cross-project / cross-tester lists still exist; we just point at them
     * via "View all" links from the parent detail page rather than having a
     * permanent sidebar entry.
     */
    label: 'Delivery',
    links: [
      { href: '/app/admin/projects', label: 'Projects', icon: 'briefcase' },
    ],
  },
  {
    label: 'Operations',
    links: [
      { href: '/app/admin/transactions', label: 'Transactions', icon: 'credit-card' },
      { href: '/app/admin/communication', label: 'Communication', icon: 'message-square' },
    ],
  },
  {
    label: 'Account',
    links: [{ href: '/app/admin/profile', label: 'Your profile', icon: 'user-check' }],
  },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])

  // The current path, read from the request headers set by Next. We don't
  // trust the value for anything except "what link should be highlighted".
  const headerList = await headers()
  const pathname = headerList.get('x-pathname') ?? headerList.get('x-invoke-path') ?? '/app/admin'

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email

  return (
    <div style={{ display: 'flex', minHeight: '100dvh', background: 'var(--surface-sunken)' }}>
      <Sidebar pathname={pathname} userName={displayName} role={user.role} sections={SECTIONS} />

      {/* Each page renders its own <Topbar> (so the breadcrumb reflects the
          route) followed by its own <main id="main">. The landmark is NOT
          here: the Topbar carries a nav and the sign-out control, neither of
          which belongs inside main. See the note in app/layout.tsx. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}

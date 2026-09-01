import type { Metadata } from 'next'
import { requireRole, hasPermission } from '@/lib/auth/session'
import { Sidebar, type SidebarSection } from '@/components/admin/Sidebar'
import { AppShell } from '@/components/admin/AppShell'

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
 * The sidebar's active-link highlight used to be computed here (from a
 * request header) and passed down as a `pathname` prop. That was wrong: this
 * layout does not re-render on a client-side navigation within its own
 * segment, so the prop went stale after the first page load — every sidebar
 * link click left "Dashboard" looking open no matter which page was actually
 * showing. `Sidebar` now reads its own pathname via `usePathname()`, which
 * updates on every navigation regardless of whether this layout re-runs.
 */

const SECTIONS: readonly SidebarSection[] = [
  {
    // No group label — a "Dashboard" heading over the one "Dashboard" link
    // would just repeat itself. Every other group is a category of several
    // links; this one is a single top-level destination.
    links: [{ href: '/app/admin', label: 'Dashboard', icon: 'layout-dashboard' }],
  },
  {
    label: 'Pipeline',
    links: [{ href: '/app/admin/leads', label: 'Leads', icon: 'mail', permission: 'lead.read' }],
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
      {
        href: '/app/admin/organisations',
        label: 'Organisations',
        icon: 'building-2',
        permission: 'organisation.read',
      },
      { href: '/app/admin/users', label: 'Users', icon: 'user-check', permission: 'user.read' },
      { href: '/app/admin/testers', label: 'Testers', icon: 'users', permission: 'tester.read' },
      {
        href: '/app/admin/managers',
        label: 'Managers',
        icon: 'shield-check',
        permission: 'manager.read',
      },
      {
        href: '/app/admin/assets/devices',
        label: 'Devices',
        icon: 'smartphone',
        permission: 'tester.read',
      },
      {
        href: '/app/admin/assets/browsers',
        label: 'Browsers',
        icon: 'monitor',
        permission: 'tester.read',
      },
      {
        href: '/app/admin/assets/skills',
        label: 'Skills',
        icon: 'graduation-cap',
        permission: 'tester.read',
      },
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
      {
        href: '/app/admin/projects',
        label: 'Projects',
        icon: 'briefcase',
        permission: 'project.read',
      },
    ],
  },
  {
    label: 'Reports',
    links: [
      {
        href: '/app/admin/reports',
        label: 'Reports',
        icon: 'line-chart',
        permission: 'stats.read',
      },
    ],
  },
  {
    label: 'Content',
    links: [{ href: '/app/admin/blog', label: 'Blog', icon: 'newspaper', permission: 'blog.read' }],
  },
  {
    label: 'Operations',
    links: [
      {
        href: '/app/admin/transactions',
        label: 'Transactions',
        icon: 'credit-card',
        permission: 'transaction.read',
      },
      {
        href: '/app/admin/communication',
        label: 'Communication',
        icon: 'message-square',
        permission: 'communication.read',
      },
      {
        href: '/app/admin/catalog',
        label: 'Catalog',
        icon: 'layout-grid',
        permission: 'tester.read',
      },
    ],
  },
  {
    label: 'Account',
    links: [
      { href: '/app/admin/profile', label: 'Your profile', icon: 'user-check' },
      // Platform-wide values every account inherits — an administrator's
      // call, not something to hand out with a read permission.
      { href: '/app/admin/settings', label: 'Settings', icon: 'settings', roles: ['ADMIN'] },
    ],
  },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email

  /**
   * The panel a SUB_ADMIN sees is the panel they can use.
   *
   * Admin and sub-admin share these routes — one portal, permissions decide
   * the scope — but the nav was the full administrator list for everyone. A
   * sub-admin granted read on projects and testers still saw Users, Managers,
   * Transactions and Settings, and every one of them answered with a 403 or
   * "ask an administrator for this permission". That reads as a broken panel
   * rather than a scoped one.
   *
   * Filtered here rather than inside `Sidebar` because only a Server
   * Component knows who is signed in, and this keeps the account's whole
   * permission set off the wire. `hasPermission` returns true for ADMIN
   * without consulting anything, so an administrator's nav is unchanged.
   *
   * The page behind each link enforces the same code itself — this decides
   * what is worth showing, never what is allowed.
   */
  const sections = SECTIONS.map((section) => ({
    ...section,
    links: section.links.filter((link) => !link.permission || hasPermission(user, link.permission)),
  })).filter((section) => section.links.length > 0)

  return (
    <AppShell
      nav={
        <Sidebar
          userName={displayName}
          avatarFileId={user.avatarFileId}
          role={user.role}
          sections={sections}
        />
      }
    >
      {/* Each page renders its own <Topbar> (so the breadcrumb reflects the
          route) followed by its own <main id="main">. The landmark is NOT
          here: the Topbar carries a nav and the sign-out control, neither of
          which belongs inside main. See the note in app/layout.tsx. */}
      {children}
    </AppShell>
  )
}

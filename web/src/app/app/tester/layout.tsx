import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/session'
import { Sidebar, type SidebarSection } from '@/components/admin/Sidebar'
import { AppShell } from '@/components/admin/AppShell'

export const metadata: Metadata = {
  title: 'Tester',
  robots: { index: false, follow: false },
}

/**
 * The tester area — `/app/tester/*`.
 *
 * Same shell as `admin/layout.tsx`: gates the route to TESTER, then mounts
 * the sidebar. Every page below renders its own `<Topbar>`/`<main>`, for the
 * same reason admin's pages do — this layout does not re-render on a
 * client-side navigation within its own segment.
 */

const TESTER_SECTIONS: readonly SidebarSection[] = [
  {
    links: [{ href: '/app/tester', label: 'Dashboard', icon: 'layout-dashboard' }],
  },
  {
    label: 'Work',
    links: [
      { href: '/app/tester/projects', label: 'Projects', icon: 'briefcase' },
      { href: '/app/tester/bugs', label: 'Bugs', icon: 'clipboard-check' },
      { href: '/app/tester/test-cases', label: 'Test cases', icon: 'test-tube-diagonal' },
    ],
  },
  {
    label: 'Updates',
    links: [{ href: '/app/tester/announcements', label: 'Announcements', icon: 'message-square' }],
  },
  {
    label: 'Account',
    links: [
      { href: '/app/tester/profile', label: 'Your profile', icon: 'user-check' },
      { href: '/app/tester/settings', label: 'Settings', icon: 'settings' },
    ],
  },
]

export default async function TesterLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole(['TESTER'], '/app/tester')

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email

  return (
    <AppShell
      nav={
        <Sidebar
          userName={displayName}
          role={user.role}
          sections={TESTER_SECTIONS}
          homeHref="/app/tester"
          portalLabel="Tester"
        />
      }
    >
      {children}
    </AppShell>
  )
}

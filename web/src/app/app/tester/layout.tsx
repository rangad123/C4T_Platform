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
    links: [{ href: '/app/tester/projects', label: 'Projects', icon: 'briefcase' }],
  },
  /**
   * Two entries, because they are two different things. Announcements are a
   * one-way broadcast the platform writes and testers read; Communication is
   * a real conversation with a reply box. Folding the second name onto the
   * first would have promised a reply button that does not exist there.
   */
  {
    label: 'Updates',
    links: [
      /*
       * Announcements is deliberately not here.
       *
       * A build-scoped announcement belongs to the build it is about, and is
       * read at Project → Build → Announcements. A platform-wide one is
       * broadcast, which is what Communications is for, and appears in that
       * inbox alongside the conversations. Neither wanted a flat global feed
       * of its own, which showed both kinds stripped of the context that made
       * them mean anything.
       */
      { href: '/app/tester/communication', label: 'Communication', icon: 'message-square' },
    ],
  },
  {
    label: 'Account',
    links: [
      /*
       * The profile's sections get their own entries rather than only being
       * tabs on the page. They are the things a tester actually comes here to
       * do — add a device, list a skill, get paid — and burying each one
       * behind "Your profile" made them a second click and a hunt for the
       * right tab. `Sidebar` tells them apart by their `?section=`; see the
       * active-state note there.
       */
      { href: '/app/tester/profile', label: 'Your profile', icon: 'user-check' },
      { href: '/app/tester/profile?section=assets', label: 'Assets', icon: 'smartphone' },
      {
        href: '/app/tester/profile?section=skills',
        label: 'Skills and languages',
        icon: 'briefcase',
      },
      {
        href: '/app/tester/profile?section=payment',
        label: 'Payment details',
        icon: 'credit-card',
      },
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
          avatarFileId={user.avatarFileId}
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

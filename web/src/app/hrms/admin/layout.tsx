import type { Metadata } from 'next'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { HrSidebar, type HrSidebarSection } from '@/components/hrms/HrSidebar'
import { AppShell } from '@/components/admin/AppShell'

/**
 * No `title` here, deliberately — every page under `/admin/*` sets its own,
 * and a plain-string layout title breaks the parent template for anything
 * nested one level deeper than this layout's own index page. Confirmed live:
 * `/admin` (this layout's index) correctly rendered "Employees — Crowd4Test
 * HRMS", but `/admin/new` and `/admin/old-employees` rendered as bare
 * "Add employee" / "Old employees" with no suffix, from the exact same
 * `{ title: 'X' }` export shape — the only difference was nesting depth past
 * a layout that itself set a bare `title`. Removing it here restores the
 * `app/hrms/layout.tsx` template (`%s — Crowd4Test HRMS`) for every depth.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

const SECTIONS: readonly HrSidebarSection[] = [
  { links: [{ href: '/admin', label: 'Employees', icon: 'users' }] },
  { links: [{ href: '/admin/old-employees', label: 'Old employees', icon: 'user-check' }] },
  { links: [{ href: '/admin/reports', label: 'Reports', icon: 'line-chart' }] },
  { links: [{ href: '/admin/templates', label: 'Templates', icon: 'file-text' }] },
  { links: [{ href: '/admin/payslip', label: 'Payslip', icon: 'credit-card' }] },
  { links: [{ href: '/admin/holidays', label: 'Holidays list', icon: 'calendar' }] },
]

/**
 * The HR Admin Portal — `/admin/*` (visible on hrms.crowd4test.com; the
 * `/hrms` prefix is an internal rewrite). Gated to `ADMIN` only: Account
 * Managers and Employees use the Employee Portal at `/employee/*`.
 */
export default async function HrAdminLayout({ children }: { children: React.ReactNode }) {
  const employee = await requireHrRole(['ADMIN'])
  const displayName = `${employee.firstName} ${employee.lastName}`.trim() || employee.email

  return (
    <AppShell
      nav={
        <HrSidebar
          userName={displayName}
          avatarFileId={employee.profilePictureFileId}
          role={employee.role}
          sections={SECTIONS}
          homeHref="/admin"
          portalLabel="Admin"
        />
      }
    >
      {children}
    </AppShell>
  )
}

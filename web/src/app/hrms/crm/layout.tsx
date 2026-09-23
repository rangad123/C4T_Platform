import type { Metadata } from 'next'
import { requireCrmAccess } from '@/lib/hrms/hr-session'
import { hasCrmCapability } from '@/lib/hrms/hr-crm-capabilities'
import { HrSidebar, type HrSidebarSection } from '@/components/hrms/HrSidebar'
import { AppShell } from '@/components/admin/AppShell'

/** No `title` here — see the identical note in `app/hrms/admin/layout.tsx`. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * CRM's own three sections, each gated by the capability that owns it —
 * exactly the spec's "A user without the relevant permission must not see or
 * access the section." Dashboard and All Leads need nothing beyond CRM
 * access itself (every tier has `view_dashboard`/`view_leads`, just scoped
 * differently — see `hr-crm-capabilities.ts`); Catalog is a real gate.
 *
 * There is deliberately no "Add Employee" section: granting CRM access is
 * already how someone gets into CRM at all (the Module access toggle on
 * their employee record), so a second, CRM-side entry point into employee
 * creation was a redundant door to the same room.
 */
function sectionsFor(crmRole: 'ADMIN' | 'MANAGER' | 'EMPLOYEE'): readonly HrSidebarSection[] {
  return [
    {
      links: [
        { href: '/crm', label: 'Dashboard', icon: 'layout-dashboard' },
        { href: '/crm/leads', label: 'All Leads', icon: 'handshake' },
        ...(hasCrmCapability(crmRole, 'manage_catalog')
          ? [{ href: '/crm/catalog', label: 'Catalog', icon: 'list' as const }]
          : []),
      ],
    },
  ]
}

/**
 * The CRM portal — `/crm/*`. A third portal shell alongside Admin and
 * Employee, not nested under either: CRM tier is a second, independent
 * access axis from `HrRole` (an ordinary EMPLOYEE can be CRM Administrator;
 * an HR ADMIN can have CRM off entirely), so it needs its own sidebar rather
 * than a link buried inside one of the other two.
 *
 * `requireCrmAccess` is the frontend convenience gate — the real enforcement
 * is every CRM API route's own `requireCrmAccess`/`requireCrmCapability`
 * middleware, checked independently on every request.
 */
export default async function HrCrmLayout({ children }: { children: React.ReactNode }) {
  const employee = await requireCrmAccess()
  const displayName = `${employee.firstName} ${employee.lastName}`.trim() || employee.email
  // requireCrmAccess already refused anyone without a role, so this is safe.
  const crmRole = employee.crmRole!

  return (
    <AppShell
      nav={
        <HrSidebar
          userName={displayName}
          avatarFileId={employee.profilePictureFileId}
          role={employee.role}
          sections={sectionsFor(crmRole)}
          homeHref="/crm"
          portalLabel="CRM"
        />
      }
    >
      {children}
    </AppShell>
  )
}

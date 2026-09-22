import type { Metadata } from 'next'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { HrSidebar, type HrSidebarSection } from '@/components/hrms/HrSidebar'
import { AppShell } from '@/components/admin/AppShell'

/** No `title` here — see the identical note in `app/hrms/admin/layout.tsx`. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * `timesheetRequired` and `crmEnabled` decide whether their sections appear at
 * all. Both flags were already being stored on the employee's record; CRM
 * follows exactly the same "module toggle → sidebar section" pattern
 * Timesheet established, rather than a new mechanism.
 *
 * The CRM link leaves this portal entirely — `/crm` is its own portal shell
 * with its own sidebar (its tier is a separate axis from `HrRole`, so it
 * cannot just be another page under `/employee`). Hiding it here is a
 * convenience, not the security boundary: `/crm`'s own layout re-checks
 * access independently, and so does every CRM API route.
 */
function sectionsFor(flags: {
  timesheetRequired: boolean
  crmEnabled: boolean
}): readonly HrSidebarSection[] {
  return [
    { links: [{ href: '/employee/dashboard', label: 'Dashboard', icon: 'layout-dashboard' }] },
    { links: [{ href: '/employee', label: 'Basic details', icon: 'user-check' }] },
    { links: [{ href: '/employee/salary', label: 'Salary details', icon: 'banknote' }] },
    { links: [{ href: '/employee/tax', label: 'Tax calculation', icon: 'line-chart' }] },
    { links: [{ href: '/employee/investments', label: 'Investments', icon: 'landmark' }] },
    { links: [{ href: '/employee/payslip', label: 'Payslip', icon: 'credit-card' }] },
    ...(flags.timesheetRequired
      ? [{ links: [{ href: '/employee/timesheet', label: 'Timesheet', icon: 'clock' as const }] }]
      : []),
    { links: [{ href: '/employee/leaves', label: 'Leaves', icon: 'plane' }] },
    { links: [{ href: '/employee/holidays', label: 'Holidays list', icon: 'calendar' }] },
    ...(flags.crmEnabled
      ? [{ links: [{ href: '/crm', label: 'CRM', icon: 'handshake' as const }] }]
      : []),
  ]
}

/**
 * The Employee Portal — `/employee/*`. Open to every role (ADMIN and
 * ACCOUNT_MANAGER included): everyone is also an employee of their own
 * record, and an admin still needs to see their own payslip and apply for
 * their own leave here rather than through the Admin Portal, which manages
 * OTHER people's records.
 */
export default async function HrEmployeeLayout({ children }: { children: React.ReactNode }) {
  const employee = await requireHrRole(['ADMIN', 'ACCOUNT_MANAGER', 'EMPLOYEE'])
  const displayName = `${employee.firstName} ${employee.lastName}`.trim() || employee.email

  return (
    <AppShell
      nav={
        <HrSidebar
          userName={displayName}
          avatarFileId={employee.profilePictureFileId}
          role={employee.role}
          sections={sectionsFor({
            timesheetRequired: employee.timesheetRequired,
            crmEnabled: employee.crmEnabled,
          })}
          homeHref="/employee"
          portalLabel="Employee"
        />
      }
    >
      {children}
    </AppShell>
  )
}

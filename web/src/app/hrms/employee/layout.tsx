import type { Metadata } from 'next'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { HrSidebar, type HrSidebarSection } from '@/components/hrms/HrSidebar'
import { AppShell } from '@/components/admin/AppShell'

/** No `title` here — see the identical note in `app/hrms/admin/layout.tsx`. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

/**
 * `timesheetRequired` decides whether Timesheet appears at all. The flag was
 * being stored and shown on the employee's record but drove nothing, so staff
 * who are not expected to fill one in were still offered the section.
 */
function sectionsFor(timesheetRequired: boolean): readonly HrSidebarSection[] {
  return [
    { links: [{ href: '/employee', label: 'Basic details', icon: 'user-check' }] },
    { links: [{ href: '/employee/salary', label: 'Salary details', icon: 'banknote' }] },
    { links: [{ href: '/employee/tax', label: 'Tax calculation', icon: 'line-chart' }] },
    { links: [{ href: '/employee/investments', label: 'Investments', icon: 'landmark' }] },
    { links: [{ href: '/employee/payslip', label: 'Payslip', icon: 'credit-card' }] },
    ...(timesheetRequired
      ? [{ links: [{ href: '/employee/timesheet', label: 'Timesheet', icon: 'clock' as const }] }]
      : []),
    { links: [{ href: '/employee/leaves', label: 'Leaves', icon: 'plane' }] },
    { links: [{ href: '/employee/holidays', label: 'Holidays list', icon: 'calendar' }] },
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
          sections={sectionsFor(employee.timesheetRequired)}
          homeHref="/employee"
          portalLabel="Employee"
        />
      }
    >
      {children}
    </AppShell>
  )
}

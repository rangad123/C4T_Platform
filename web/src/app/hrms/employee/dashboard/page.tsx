import type { Metadata } from 'next'
import { requireHrEmployee } from '@/lib/hrms/hr-session'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'

export const metadata: Metadata = { title: 'Dashboard' }

const BASE = '/employee'

/**
 * A lightweight "your modules" landing page, added as its own sidebar entry
 * rather than replacing `/employee` (Basic details) — same reasoning as the
 * Admin Portal's own dashboard. Timesheet and CRM cards are each shown only
 * when the signed-in employee's own flag is on; a disabled module truly
 * shows nothing here, matching the sidebar's own gating.
 */
export default async function HrEmployeeDashboardPage() {
  const employee = await requireHrEmployee()

  return (
    <HrPageShell
      crumbs={[{ label: 'Dashboard' }]}
      root={{ label: 'Employee', href: BASE }}
      eyebrow="Employee"
      title="Dashboard"
      subtitle="Your modules, at a glance."
    >
      <Panel title="Your modules">
        {!employee.timesheetRequired && !employee.crmEnabled ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Nothing extra is switched on for your account yet — your basic details, leaves and
            payslip are in the sidebar.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {employee.timesheetRequired ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                  You&rsquo;re expected to fill in a timesheet.
                </p>
                <Button
                  href="/employee/timesheet"
                  variant="secondary"
                  iconLeft="clock"
                  style={{ alignSelf: 'flex-start' }}
                >
                  Open timesheet
                </Button>
              </div>
            ) : null}
            {employee.crmEnabled ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                  CRM is on for your account. Open it to see your leads.
                </p>
                <Button href="/crm" iconLeft="handshake" style={{ alignSelf: 'flex-start' }}>
                  Open CRM
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </HrPageShell>
  )
}

import type { Metadata } from 'next'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'

export const metadata: Metadata = { title: 'Dashboard' }

const BASE = '/admin'

/**
 * A lightweight "your modules" landing page, added as its own sidebar entry
 * rather than replacing `/admin` (the Employees list) — the plan called this
 * out explicitly rather than silently redirecting a page people already
 * rely on. Shows a CRM card only when this ADMIN's own `crmEnabled` is on —
 * an HR administrator can have CRM switched off entirely, and this page must
 * not assume otherwise.
 */
export default async function HrAdminDashboardPage() {
  const employee = await requireHrRole(['ADMIN'])

  return (
    <HrPageShell
      crumbs={[{ label: 'Dashboard' }]}
      root={{ label: 'Admin', href: BASE }}
      eyebrow="Admin"
      title="Dashboard"
      subtitle="Your modules, at a glance."
    >
      <Panel title="Your modules">
        {employee.crmEnabled ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              CRM is on for your account. Open it to see your leads and the team&rsquo;s numbers.
            </p>
            <Button href="/crm" iconLeft="handshake" style={{ alignSelf: 'flex-start' }}>
              Open CRM
            </Button>
          </div>
        ) : (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            CRM is not switched on for your account. An administrator can turn it on from your
            employee record.
          </p>
        )}
      </Panel>
    </HrPageShell>
  )
}

import type { Metadata } from 'next'
import { requireCrmAccess } from '@/lib/hrms/hr-session'
import { hasCrmCapability, canAddEmployeeFromCrm } from '@/lib/hrms/hr-crm-capabilities'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'

export const metadata: Metadata = { title: 'Dashboard' }

const CRM_ROLE_LABEL: Record<'ADMIN' | 'MANAGER' | 'EMPLOYEE', string> = {
  ADMIN: 'CRM administrator',
  MANAGER: 'CRM manager',
  EMPLOYEE: 'CRM employee',
}

/**
 * The CRM landing page. A genuine placeholder — the role-tiered widget
 * dashboard the spec describes (My Leads / Team Leads / org-wide totals) is
 * Phase 3 — but a real one, not a stub: it already reads the signed-in
 * employee's actual `crmRole` and builds its Quick Links the same
 * capability-aware way the eventual dashboard will, so nothing here gets
 * thrown away once the widgets are built, and the nav → guard → landing
 * chain is fully clickable today.
 */
export default async function HrCrmDashboardPage() {
  const employee = await requireCrmAccess()
  const crmRole = employee.crmRole!

  return (
    <HrPageShell
      crumbs={[{ label: 'Dashboard' }]}
      root={{ label: 'CRM', href: '/crm' }}
      eyebrow={CRM_ROLE_LABEL[crmRole]}
      title="CRM"
      subtitle="Leads, contacts and follow-ups."
    >
      <Panel title="Quick links" description="Jump straight to what you use most.">
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Button href="/crm/leads" iconLeft="handshake">
            All leads
          </Button>
          {hasCrmCapability(crmRole, 'manage_catalog') ? (
            <Button href="/crm/catalog" variant="secondary" iconLeft="list">
              Catalog
            </Button>
          ) : null}
          {canAddEmployeeFromCrm(crmRole, employee.role) ? (
            <Button href="/crm/employees/new" variant="secondary" iconLeft="user-check">
              Add employee
            </Button>
          ) : null}
        </div>
      </Panel>

      <Panel title="Dashboard widgets" description="Coming in a later phase of this build.">
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          This page will show{' '}
          {crmRole === 'EMPLOYEE'
            ? 'your assigned leads, new and hot leads, and upcoming follow-ups'
            : crmRole === 'MANAGER'
              ? "your team's leads and workload by employee"
              : 'organisation-wide totals, conversion, and unassigned leads'}
          .
        </p>
      </Panel>
    </HrPageShell>
  )
}

import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { requireCrmAccess } from '@/lib/hrms/hr-session'
import { hasCrmCapability, canAddEmployeeFromCrm } from '@/lib/hrms/hr-crm-capabilities'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { KpiCard } from '@/components/admin/KpiCard'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Button } from '@/components/ds/core/Button'

export const metadata: Metadata = { title: 'Dashboard' }

const CRM_ROLE_LABEL: Record<'ADMIN' | 'MANAGER' | 'EMPLOYEE', string> = {
  ADMIN: 'CRM administrator',
  MANAGER: 'CRM manager',
  EMPLOYEE: 'CRM employee',
}

interface CrmDashboardStats {
  scope: 'own' | 'all'
  own?: { total: number; new: number; hot: number; stale: number }
  all?: {
    total: number
    unassigned: number
    byStatus: { status: string; count: number }[]
    byEmployee: { employeeId: string; name: string; count: number }[]
    conversionRate: number
  }
}

/**
 * The CRM dashboard — built from `/crm/leads/stats`, which returns `own` or
 * `all` scoped numbers based on the visitor's `view_dashboard` capability
 * scope, never from `crmRole`'s name directly (a MANAGER and an ADMIN share
 * the `all` scope, so they see identical data here; only the page's own
 * widget selection below leans on role for presentation, never for access).
 */
export default async function HrCrmDashboardPage() {
  const employee = await requireCrmAccess()
  const crmRole = employee.crmRole!

  const stats = await serverFetchOrNull<CrmDashboardStats>('hrms/crm/leads/stats')

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

      {stats?.scope === 'own' && stats.own ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          <KpiCard icon="handshake" label="My leads" value={stats.own.total} href="/crm/leads" />
          <KpiCard icon="sparkles" label="New" value={stats.own.new} href="/crm/leads?status=NEW" />
          <KpiCard icon="zap" label="Hot" value={stats.own.hot} href="/crm/leads?status=HOT" />
          <KpiCard icon="clock" label="Needs follow-up" value={stats.own.stale} href="/crm/leads" />
        </div>
      ) : stats?.scope === 'all' && stats.all ? (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            <KpiCard
              icon="handshake"
              label="Team leads"
              value={stats.all.total}
              href="/crm/leads"
            />
            <KpiCard
              icon="user-check"
              label="Unassigned"
              value={stats.all.unassigned}
              href="/crm/leads?assignedToId=unassigned"
            />
            <KpiCard
              icon="badge-check"
              label="Clients"
              value={stats.all.byStatus.find((s) => s.status === 'CLIENT')?.count ?? 0}
              href="/crm/leads?status=CLIENT"
            />
            <KpiCard
              icon="trending-up"
              label="Conversion"
              value={`${(stats.all.conversionRate * 100).toFixed(1)}%`}
              href="/crm/leads"
            />
          </div>

          <Panel title="By status">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
              {stats.all.byStatus.map((row) => (
                <a
                  key={row.status}
                  href={`/crm/leads?status=${row.status}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-card)',
                    border: '1px solid var(--border-default)',
                    textDecoration: 'none',
                  }}
                >
                  <StatusBadge status={row.status} />
                  <span
                    style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {row.count}
                  </span>
                </a>
              ))}
            </div>
          </Panel>

          {stats.all.byEmployee.length > 0 ? (
            <Panel title="Workload by employee">
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                {stats.all.byEmployee.map((row) => (
                  <li key={row.employeeId}>
                    <a
                      href={`/crm/leads?assignedToId=${row.employeeId}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        color: 'var(--text-primary)',
                        textDecoration: 'none',
                      }}
                    >
                      <span>{row.name}</span>
                      <span
                        style={{
                          fontVariantNumeric: 'tabular-nums',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {row.count}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </>
      ) : (
        <Panel title="Dashboard">
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Could not load your CRM numbers.
          </p>
        </Panel>
      )}
    </HrPageShell>
  )
}

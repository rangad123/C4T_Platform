import type { Metadata } from 'next'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { serverFetchOrNull } from '@/lib/api/server'
import { formatDate } from '@/lib/admin/format'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { KpiCard } from '@/components/admin/KpiCard'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'

export const metadata: Metadata = { title: 'Dashboard' }

const BASE = '/admin'

interface AdminDashboardStats {
  activeEmployees: number
  resignedThisMonth: number
  upcomingHolidaysThisMonth: { id: string; date: string; name: string }[]
  leavesAppliedThisMonth: number
  pendingLeaveApprovals: number
}

const MONTH_LABEL = new Date().toLocaleDateString('en-US', { month: 'long' })

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
  const stats = await serverFetchOrNull<AdminDashboardStats>('hrms/dashboard/admin/stats')

  return (
    <HrPageShell
      crumbs={[{ label: 'Dashboard' }]}
      root={{ label: 'Admin', href: BASE }}
      eyebrow="Admin"
      title="Dashboard"
      subtitle="Your modules, at a glance."
    >
      {/*
        The spec asked for a centred image here, matching the one asked for
        on the Employee dashboard. No approved image asset exists anywhere in
        HRMS today (every existing "image" in this portal is a CSS watermark,
        not a real picture) — per this repo's own rule against inventing
        content, this is left as a gap rather than a stock photo. Give us a
        real image (a remote URL, or a file to host) and its alt text, and
        this slot is a one-line addition.
      */}

      {stats ? (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            <KpiCard
              icon="users"
              label="Active employees"
              value={stats.activeEmployees}
              href="/admin"
            />
            <KpiCard
              icon="log-out"
              label={`Resigned in ${MONTH_LABEL}`}
              value={stats.resignedThisMonth}
              href="/admin/old-employees"
            />
            <KpiCard
              icon="calendar"
              label={`Holidays left in ${MONTH_LABEL}`}
              value={stats.upcomingHolidaysThisMonth.length}
              href="/admin/holidays"
            />
            <KpiCard
              icon="clipboard-check"
              label={`Leaves applied in ${MONTH_LABEL}`}
              value={stats.leavesAppliedThisMonth}
              href="/admin/leaves"
            />
          </div>

          <Panel
            title="Reminders"
            description="Worth a look before the month is out."
            actions={
              <Button href="/admin/leaves" variant="secondary" size="sm">
                Review leaves
              </Button>
            }
          >
            {stats.pendingLeaveApprovals > 0 || stats.upcomingHolidaysThisMonth.length > 0 ? (
              <ul
                style={{ margin: 0, paddingLeft: 'var(--space-5)', color: 'var(--text-secondary)' }}
              >
                {stats.pendingLeaveApprovals > 0 ? (
                  <li>
                    {stats.pendingLeaveApprovals} leave{' '}
                    {stats.pendingLeaveApprovals === 1 ? 'request is' : 'requests are'} waiting on
                    your approval.
                  </li>
                ) : null}
                {stats.upcomingHolidaysThisMonth.map((holiday) => (
                  <li key={holiday.id}>
                    {holiday.name} — {formatDate(holiday.date)}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                Nothing pending this month.
              </p>
            )}
          </Panel>
        </>
      ) : (
        <Panel title="Dashboard">
          <EmptyState icon="alert-triangle" title="Could not load dashboard stats" />
        </Panel>
      )}

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

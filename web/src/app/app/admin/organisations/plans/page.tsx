import { DetailShell } from '@/components/admin/DetailShell'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { Table } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { serverFetch } from '@/lib/api/server'
import { hasPermission, requirePermission } from '@/lib/auth/session'
import { formatMoney } from '@/lib/admin/format'
import { createPlan, setPlanArchived } from './actions'

/**
 * `/app/admin/organisations/plans` — the plans an admin can give an
 * organisation (legacy `active_plans` / `pricing_models`). Price and quotas
 * are recorded for reference; nothing bills automatically. An archived plan
 * stays on the organisations that hold it but cannot be given to another.
 */

const NOTICES: Record<string, NoticeCopy> = {
  created: { tone: 'success', message: 'Plan created.' },
  archived: { tone: 'success', message: 'Plan archived.' },
  restored: { tone: 'success', message: 'Plan restored.' },
}

interface Plan {
  id: string
  name: string
  description: string | null
  priceMinor: string | null
  currency: string
  projectsIncluded: number | null
  privateTestersIncluded: number | null
  archivedAt: string | null
}

const row = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-4)',
  alignItems: 'flex-end',
} as const

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>
}) {
  const user = await requirePermission('transaction.read')
  const canWrite = hasPermission(user, 'transaction.write')
  const { notice, error } = await searchParams
  const plans = await serverFetch<Plan[]>('org-finance/plans')

  return (
    <DetailShell
      crumbs={[{ label: 'Organisations', href: '/app/admin/organisations' }, { label: 'Plans' }]}
      eyebrow="Finance"
      title="Plans"
      subtitle="The plans an organisation can hold. Give one to an organisation from its wallet page."
    >
      <Notice code={notice} notices={NOTICES} />
      {error ? (
        <p
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            margin: 0,
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-card)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <Icon name="alert-triangle" size={16} />
          <span>{error.slice(0, 240)}</span>
        </p>
      ) : null}

      {canWrite ? (
        <Panel title="New plan">
          <form
            action={createPlan}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <div style={row}>
              <Field label="Name" htmlFor="plan-name" required>
                <Input id="plan-name" name="name" required minLength={2} maxLength={80} />
              </Field>
              <Field label="Price" htmlFor="plan-price" hint="Optional. Major units.">
                <Input id="plan-price" name="price" inputMode="decimal" autoComplete="off" />
              </Field>
              <Field label="Currency" htmlFor="plan-currency">
                <Select
                  id="plan-currency"
                  name="currency"
                  defaultValue="INR"
                  options={['INR', 'USD']}
                />
              </Field>
              <Field label="Projects included" htmlFor="plan-projects">
                <Input id="plan-projects" name="projectsIncluded" inputMode="numeric" />
              </Field>
              <Field label="Private testers included" htmlFor="plan-testers">
                <Input id="plan-testers" name="privateTestersIncluded" inputMode="numeric" />
              </Field>
              <Field label="Description" htmlFor="plan-description">
                <Input id="plan-description" name="description" maxLength={1000} />
              </Field>
            </div>
            <div>
              <SubmitButton iconLeft="plus" pendingLabel="Creating…">
                Create plan
              </SubmitButton>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel title="All plans" flush>
        <Table<Plan>
          ariaLabel="Plans"
          rows={plans}
          rowKey={(p) => p.id}
          emptyState={
            <EmptyState
              variant="inline"
              icon="credit-card"
              title="No plans yet"
              description="Create the first plan above."
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Plan',
              render: (p) => p.name,
              renderSecondary: (p) => p.description ?? undefined,
            },
            {
              key: 'price',
              header: 'Price',
              align: 'right',
              render: (p) => (p.priceMinor ? formatMoney(p.priceMinor, p.currency) : '—'),
            },
            {
              key: 'quota',
              header: 'Included',
              render: (p) =>
                `${p.projectsIncluded ?? '—'} projects · ${p.privateTestersIncluded ?? '—'} testers`,
            },
            {
              key: 'state',
              header: 'State',
              interactive: true,
              render: (p) =>
                canWrite ? (
                  <form action={setPlanArchived}>
                    <input type="hidden" name="planId" value={p.id} />
                    <input type="hidden" name="archived" value={p.archivedAt ? 'false' : 'true'} />
                    <SubmitButton variant="ghost" size="sm" pendingLabel="Saving…">
                      {p.archivedAt ? 'Restore' : 'Archive'}
                    </SubmitButton>
                  </form>
                ) : p.archivedAt ? (
                  'Archived'
                ) : (
                  'Active'
                ),
            },
          ]}
        />
      </Panel>
    </DetailShell>
  )
}

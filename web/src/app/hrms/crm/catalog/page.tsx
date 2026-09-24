import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { requireCrmCapability } from '@/lib/hrms/hr-session'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { createCrmCatalogEntry, setCrmCatalogEntryActive } from './actions'

export const metadata: Metadata = { title: 'Catalog' }

const KINDS = [
  { value: 'crm-industries', label: 'Industries' },
  { value: 'crm-lead-sources', label: 'Lead sources' },
  { value: 'crm-communication-statuses', label: 'Communication statuses' },
] as const

type Kind = (typeof KINDS)[number]['value']

interface Entry {
  id: string
  name: string
  isActive: boolean
}

const NOTICES: Record<string, string> = {
  created: 'Entry added.',
  retired: 'Entry retired. It no longer appears in pickers.',
  restored: 'Entry restored.',
}

const ERRORS: Record<string, string> = {
  duplicate: 'An entry with that name already exists.',
  failed: 'That change could not be saved.',
  unknown_kind: 'Unknown catalogue.',
}

/**
 * CRM's own Catalog section — same generic dispatcher as `/admin/catalogues`
 * (same two tables, `crm-industries`/`crm-lead-sources`), but reached through
 * `manage_catalog` rather than `HrRole.ADMIN`: a CRM Administrator is not
 * necessarily an HR Administrator, so this page and its API routes are
 * gated independently rather than requiring the visitor to also be one.
 */
export default async function HrCrmCataloguePage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; notice?: string; error?: string }>
}) {
  await requireCrmCapability('manage_catalog')
  const params = await searchParams
  const kind: Kind = KINDS.find((k) => k.value === params.kind)?.value ?? 'crm-industries'
  const label = KINDS.find((k) => k.value === kind)!.label

  const entries = (await serverFetchOrNull<Entry[]>(`hrms/catalog/crm/${kind}`)) ?? []
  const notice = params.notice ? NOTICES[params.notice] : null
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.failed) : null

  const columns: readonly TableColumn<Entry>[] = [
    { key: 'name', header: 'Name', render: (row) => row.name },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={row.isActive ? 'ACTIVE' : 'RETIRED'} />,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <form action={setCrmCatalogEntryActive}>
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="isActive" value={row.isActive ? 'false' : 'true'} />
          <SubmitButton
            variant="secondary"
            size="sm"
            iconLeft={row.isActive ? 'eye-off' : 'check-check'}
            pendingLabel="Saving…"
          >
            {row.isActive ? 'Retire' : 'Restore'}
          </SubmitButton>
        </form>
      ),
    },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Catalog' }]}
      root={{ label: 'CRM', href: '/crm' }}
      eyebrow="CRM"
      title="Catalog"
      subtitle="The industries, lead sources and communication statuses every lead form picks from."
    >
      <LiveGetForm
        action="/crm/catalog"
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      >
        <Select name="kind" defaultValue={kind} options={[...KINDS]} />
        <LiveFormStatus />
      </LiveGetForm>

      {notice ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-success-bg)',
            color: 'var(--status-success-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <Icon name="check-circle-2" size={18} style={{ flex: 'none' }} />
          <span>{notice}</span>
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <Icon name="alert-triangle" size={18} style={{ flex: 'none' }} />
          <span>{error}</span>
        </div>
      ) : null}

      <Panel
        title={label}
        description="Retiring an entry removes it from pickers without touching leads that already use it."
      >
        {entries.length > 0 ? (
          <Table ariaLabel={label} columns={columns} rows={entries} rowKey={(row) => row.id} />
        ) : (
          <EmptyState icon="list" title={`No ${label.toLowerCase()} yet`} />
        )}

        <TrackedForm
          action={createCrmCatalogEntry}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="kind" value={kind} />
          <Field label="Name" htmlFor="name" required>
            <Input id="name" name="name" required maxLength={80} />
          </Field>
          <SubmitButton variant="primary" iconLeft="plus" pendingLabel="Adding…">
            Add entry
          </SubmitButton>
        </TrackedForm>
      </Panel>
    </HrPageShell>
  )
}

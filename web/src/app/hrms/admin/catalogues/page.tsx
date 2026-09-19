import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
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
import { createCatalogEntry, setCatalogEntryActive } from './actions'

export const metadata: Metadata = { title: 'Catalogues' }

const KINDS = [
  { value: 'designations', label: 'Designations' },
  { value: 'leave-types', label: 'Leave types' },
  { value: 'incentive-types', label: 'Incentive types' },
  { value: 'investment-sections', label: 'Investment sections' },
] as const

type Kind = (typeof KINDS)[number]['value']

interface Entry {
  id: string
  name: string
  isActive: boolean
  code?: string
  defaultAnnualDays?: number
}

const NOTICES: Record<string, string> = {
  created: 'Entry added.',
  saved: 'Entry updated.',
  retired: 'Entry retired. It no longer appears in pickers.',
  restored: 'Entry restored.',
}

const ERRORS: Record<string, string> = {
  duplicate: 'An entry with that name already exists.',
  failed: 'That change could not be saved.',
  unknown_kind: 'Unknown catalogue.',
}

export default async function HrAdminCataloguesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; notice?: string; error?: string }>
}) {
  const params = await searchParams
  const kind: Kind = KINDS.find((k) => k.value === params.kind)?.value ?? 'designations'
  const label = KINDS.find((k) => k.value === kind)!.label

  const entries = (await serverFetchOrNull<Entry[]>(`hrms/catalog/admin/${kind}`)) ?? []
  const notice = params.notice ? NOTICES[params.notice] : null
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.failed) : null

  const columns: readonly TableColumn<Entry>[] = [
    ...(kind === 'investment-sections'
      ? [{ key: 'code', header: 'Code', render: (row: Entry) => row.code ?? '—' }]
      : []),
    { key: 'name', header: 'Name', render: (row) => row.name },
    ...(kind === 'leave-types'
      ? [
          {
            key: 'days',
            header: 'Days per year',
            align: 'right' as const,
            render: (row: Entry) => row.defaultAnnualDays ?? 0,
          },
        ]
      : []),
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
        <form action={setCatalogEntryActive}>
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
      crumbs={[{ label: 'Catalogues' }]}
      root={{ label: 'Admin', href: '/admin' }}
      eyebrow="Catalogues"
      title="Catalogues"
      subtitle="The fixed lists every employee form picks from."
    >
      <LiveGetForm
        action="/admin/catalogues"
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
        description="Retiring an entry removes it from pickers without touching records that already use it."
      >
        {entries.length > 0 ? (
          <Table ariaLabel={label} columns={columns} rows={entries} rowKey={(row) => row.id} />
        ) : (
          <EmptyState icon="list" title={`No ${label.toLowerCase()} yet`} />
        )}

        <TrackedForm
          action={createCatalogEntry}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-6)',
            alignItems: 'end',
          }}
        >
          <input type="hidden" name="kind" value={kind} />
          {kind === 'investment-sections' ? (
            <Field label="Code" htmlFor="code" required hint="e.g. 80C">
              <Input id="code" name="code" required maxLength={20} />
            </Field>
          ) : null}
          <Field label="Name" htmlFor="name" required>
            <Input id="name" name="name" required maxLength={80} />
          </Field>
          {kind === 'leave-types' ? (
            <Field label="Days per year" htmlFor="defaultAnnualDays">
              <Input
                id="defaultAnnualDays"
                name="defaultAnnualDays"
                type="number"
                min={0}
                max={365}
                defaultValue={0}
              />
            </Field>
          ) : null}
          <SubmitButton variant="primary" iconLeft="plus" pendingLabel="Adding…">
            Add entry
          </SubmitButton>
        </TrackedForm>
      </Panel>
    </HrPageShell>
  )
}

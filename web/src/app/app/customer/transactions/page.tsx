import { requireRole } from '@/lib/auth/session'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Pagination } from '@/components/ds/admin/Pagination'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Input } from '@/components/ds/forms/Input'
import { formatDate, formatMoney, personName, titleCase } from '@/lib/admin/format'

const ROOT = { label: 'Customer', href: '/app/customer' }
const BASE = '/app/customer/transactions'
const EXPORT = '/app/customer/export/transactions/export.csv'
const PAGE_SIZE = 25

/**
 * `/app/customer/transactions` — the organisation's own ledger (§2.4).
 *
 * `GET /transactions` is already organisation-scoped for a CUSTOMER caller by
 * `transactionScope`, so this page cannot show another organisation's money and
 * needs no filtering of its own.
 *
 * Nothing here moves money — the API's own note is explicit that these are
 * bookkeeping records an admin maintains. So the page is deliberately
 * read-only: there is no "pay now", because there is no payment gateway behind
 * one.
 *
 * A tester payout names the tester as its counterparty. The API withholds that
 * person's email address from a customer caller, so the name and role are all
 * this page could render even if it asked for more.
 */

const STATUSES = ['PENDING', 'APPROVED', 'RELEASED', 'PAID', 'FAILED', 'CANCELLED'] as const
const TYPES = [
  'CUSTOMER_INVOICE',
  'CUSTOMER_PAYMENT',
  'TESTER_EARNING',
  'TESTER_PAYOUT',
  'ADJUSTMENT',
  'REFUND',
] as const

interface TransactionRow {
  id: string
  reference: string
  type: string
  status: string
  amountMinor: string
  currency: string
  description: string | null
  occurredAt: string
  outstandingMinor: string
  project: { id: string; reference: string; title: string } | null
  counterparty: { id: string; firstName: string | null; lastName: string | null; role: string } | null
}

export default async function CustomerTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; type?: string; from?: string; to?: string }>
}) {
  await requireRole(['CUSTOMER'])
  const params = await searchParams
  const page = parsePage(params.page)
  const status = params.status ?? ''
  const type = params.type ?? ''
  const from = params.from ?? ''
  const to = params.to ?? ''

  const result = await loadList<TransactionRow>('transactions', {
    page,
    limit: PAGE_SIZE,
    query: { status, type, from, to, sort: 'occurredAt', order: 'desc' },
  })

  const rows = 'items' in result ? result.items : []
  const failed = 'error' in result
  const meta = 'meta' in result ? result.meta : null

  const columns: readonly TableColumn<TransactionRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => row.reference,
      renderSecondary: (row) => row.description ?? row.project?.reference ?? undefined,
    },
    { key: 'type', header: 'Type', render: (row) => titleCase(row.type) },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'counterparty',
      header: 'Counterparty',
      render: (row) => (row.counterparty ? personName(row.counterparty) : '—'),
      renderSecondary: (row) => (row.counterparty ? titleCase(row.counterparty.role) : undefined),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => formatMoney(row.amountMinor, row.currency),
      /* Only worth showing when something is actually outstanding — on a
         settled row it is always zero and just adds noise. */
      renderSecondary: (row) =>
        row.outstandingMinor !== '0'
          ? `${formatMoney(row.outstandingMinor, row.currency)} outstanding`
          : undefined,
    },
    { key: 'date', header: 'Date', align: 'right', render: (row) => formatDate(row.occurredAt) },
  ]

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Transactions' }]}
      eyebrow="Operations"
      title="Transactions"
      subtitle={
        meta ? `${meta.total} record${meta.total === 1 ? '' : 's'} on your account.` : undefined
      }
    >
      <Panel title="Filter" description="Everything here is already scoped to your organisation.">
        <LiveGetForm
          action={BASE}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'flex-end' }}
        >
          <Field label="Type" htmlFor="type" style={{ flex: '1 1 180px', maxWidth: 220 }}>
            <Select
              id="type"
              name="type"
              defaultValue={type}
              options={[
                { value: '', label: 'Any type' },
                ...TYPES.map((t) => ({ value: t, label: titleCase(t) })),
              ]}
            />
          </Field>
          <Field label="Status" htmlFor="status" style={{ flex: '1 1 160px', maxWidth: 200 }}>
            <Select
              id="status"
              name="status"
              defaultValue={status}
              options={[
                { value: '', label: 'Any status' },
                ...STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
              ]}
            />
          </Field>
          <Field label="From" htmlFor="from" style={{ flex: '1 1 150px', maxWidth: 180 }}>
            <Input id="from" name="from" type="date" defaultValue={from} />
          </Field>
          <Field label="To" htmlFor="to" style={{ flex: '1 1 150px', maxWidth: 180 }}>
            <Input id="to" name="to" type="date" defaultValue={to} />
          </Field>
          <LiveFormStatus />
          <div style={{ marginLeft: 'auto' }}>
            {/* `prefetch={false}` — this href generates a CSV on the API, and
                Next would otherwise run it on hover. */}
            <Button href={EXPORT} prefetch={false} variant="secondary" iconLeft="download">
              Download CSV
            </Button>
          </div>
        </LiveGetForm>
      </Panel>

      {failed ? (
        <EmptyState
          icon="alert-triangle"
          title="Transactions could not be loaded"
          description="Refresh in a moment."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="credit-card"
          title="No transactions yet"
          description="Invoices, payments and adjustments for your organisation appear here as they are recorded."
        />
      ) : (
        <>
          <Panel title="Ledger" flush>
            <Table
              ariaLabel="Transactions"
              columns={columns}
              rows={[...rows]}
              rowKey={(row) => row.id}
              style={{ border: 'none', borderRadius: 0 }}
            />
          </Panel>
          {meta ? (
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              limit={meta.limit}
              hrefFor={pageHrefBuilder(BASE, { status, type, from, to })}
            />
          ) : null}
        </>
      )}
    </DetailShell>
  )
}

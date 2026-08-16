import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Button } from '@/components/ds/core/Button'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, formatMoney, hasFilter, personName, titleCase } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'
import type { PageMeta } from '@/lib/api/types'

const PAGE_SIZE = 25
const BASE = '/app/admin/transactions'
const TYPES = [
  'CUSTOMER_INVOICE',
  'CUSTOMER_PAYMENT',
  'TESTER_EARNING',
  'TESTER_PAYOUT',
  'ADJUSTMENT',
  'REFUND',
] as const
const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED'] as const
const SORT_OPTIONS = [
  { value: 'occurredAt', label: 'Occurred' },
  { value: 'createdAt', label: 'Created' },
  { value: 'amountMinor', label: 'Amount' },
  { value: 'type', label: 'Type' },
  { value: 'status', label: 'Status' },
  { value: 'reference', label: 'Reference' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

/**
 * Build the CSV export URL for the current filter set. Goes through the
 * catch-all Route Handler at `/app/admin/export/[...path]` so the export
 * stays same-origin (the route streams from the API on behalf of the browser).
 */
function buildExportHref(filters: {
  type?: string
  status?: string
  sort?: string
  order?: string
}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `/app/admin/export/transactions?${qs}` : '/app/admin/export/transactions'
}

interface TransactionRow {
  id: string
  reference: string
  type: string
  status: string
  /** Minor units, serialised as a string because the column is a BigInt. */
  amountMinor: string
  currency: string
  description: string | null
  externalRef: string | null
  occurredAt: string
  settledAt: string | null
  organisation: { id: string; name: string } | null
  project: { id: string; reference: string } | null
  counterparty: {
    id: string
    firstName: string | null
    lastName: string | null
    role: string
  } | null
}

/**
 * The transactions endpoint adds a `totalsByType` array to the standard page
 * meta — the sum per type across the *whole* filtered set, not just this page.
 */
interface TransactionMeta extends PageMeta {
  totalsByType?: readonly { type: string; amountMinor: string }[]
}

/**
 * `/app/admin/transactions` — the money ledger.
 *
 * Bookkeeping only. §5 of the agreement puts gateway integration out of scope,
 * so nothing here moves money: a row is a record that someone was invoiced or
 * paid, entered by an admin.
 *
 * The totals strip sums the whole filtered result set rather than the current
 * page, which is the only version of that number worth showing — a per-page
 * subtotal of an arbitrary 25 rows means nothing.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string
    status?: string
    page?: string
    sort?: string
    order?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const type = TYPES.includes(params.type as (typeof TYPES)[number]) ? params.type : undefined
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  const result = await loadList<TransactionRow>('transactions', {
    page,
    limit: PAGE_SIZE,
    query: { type, status, sort, order },
  })

  const totals =
    'items' in result ? ((result.meta as TransactionMeta).totalsByType ?? []) : []

  const columns: readonly TableColumn<TransactionRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => row.reference,
      renderSecondary: (row) => row.description ?? row.externalRef ?? undefined,
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => titleCase(row.type),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'counterparty',
      header: 'Counterparty',
      render: (row) => personName(row.counterparty) || '—',
      renderSecondary: (row) => row.organisation?.name ?? undefined,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatMoney(row.amountMinor, row.currency)}
        </span>
      ),
    },
    {
      key: 'occurred',
      header: 'Occurred',
      align: 'right',
      render: (row) => formatDate(row.occurredAt),
      renderSecondary: (row) => (row.settledAt ? `Settled ${formatDate(row.settledAt)}` : undefined),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Operations"
      title="Transactions"
      description="Customer invoices and tester payouts, recorded by hand. Nothing here moves money — the ledger is bookkeeping, and settlement happens outside the platform."
      crumbs={[{ label: 'Transactions' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, { type, status, sort, order })}
      filtered={hasFilter([type, status])}
      permission="transaction.read"
      emptyIcon="credit-card"
      emptyTitle="No transactions yet"
      emptyDescription="Record an invoice or a payout and it appears here."
      toolbar={
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              selects={[
                { name: 'type', label: 'Type', options: TYPES, value: type, allLabel: 'All types' },
                {
                  name: 'status',
                  label: 'Status',
                  options: STATUSES,
                  value: status,
                  allLabel: 'All statuses',
                },
              ]}
              sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
            />
          </div>
          <Link href={buildExportHref({ type, status, sort, order })} prefetch={false}>
            <Button variant="secondary" iconLeft="download">
              Export CSV
            </Button>
          </Link>
        </div>
      }
      summary={
        totals.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-5)',
              padding: 'var(--space-5)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-card)',
              background: 'var(--surface-raised)',
            }}
          >
            {totals.map((total) => (
              <div
                key={total.type}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
              >
                <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                  {titleCase(total.type)}
                </span>
                <span
                  style={{
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 'var(--fw-semibold)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {formatMoney(total.amountMinor)}
                </span>
              </div>
            ))}
          </div>
        ) : null
      }
    />
  )
}

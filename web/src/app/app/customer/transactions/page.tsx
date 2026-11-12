import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, formatMoney, hasFilter, personName, titleCase } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'
import type { PageMeta } from '@/lib/api/types'
import { TRANSACTION_TYPES } from '@/lib/domain/enums'
import { serverFetch } from '@/lib/api/server'
import { WalletSummary, type Wallet } from '@/components/finance/WalletSummary'

const PAGE_SIZE = 25
const BASE = '/app/customer/transactions'
const ROOT = { label: 'Customer', href: '/app/customer' }
const SORT_OPTIONS = [
  { value: 'occurredAt', label: 'Occurred' },
  { value: 'amountMinor', label: 'Amount' },
  { value: 'type', label: 'Type' },
  { value: 'reference', label: 'Reference' },
] as const
const SORT_FIELDS = SORT_OPTIONS.map((o) => o.value)

interface TransactionRow {
  id: string
  reference: string
  type: string
  /** Minor units, serialised as a string because the column is a BigInt. */
  amountMinor: string
  currency: string
  description: string | null
  externalRef: string | null
  occurredAt: string
  project: { id: string; reference: string; title: string } | null
  build: { id: string; name: string } | null
  /** The API drops the email for a customer. */
  counterparty: { id: string; firstName: string | null; lastName: string | null } | null
}

interface TransactionMeta extends PageMeta {
  totalsByType?: readonly { type: string; currency: string; amountMinor: string }[]
}

/**
 * `/app/customer/transactions` — the billing records against this
 * organisation (§2.4 "View transaction/billing history").
 *
 * Read-only: rows are recorded by the Crowd4Test team. `GET /transactions`
 * applies `transactionScope`, so only this organisation's rows arrive. No
 * detail page and no export: the list carries everything a row holds.
 */
export default async function CustomerTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string
    projectId?: string
    sort?: string
    order?: string
    page?: string
  }>
}) {
  await requireRole(['CUSTOMER'])

  const params = await searchParams
  const type = TRANSACTION_TYPES.includes(params.type as (typeof TRANSACTION_TYPES)[number])
    ? params.type
    : undefined
  const projectId = params.projectId?.length === 25 ? params.projectId : undefined
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  const [result, wallets] = await Promise.all([
    loadList<TransactionRow>('transactions', {
      page,
      limit: PAGE_SIZE,
      query: { type, projectId, sort, order },
    }),
    // The organisation wallet (balance, locked per project, plan), read-only.
    // A failed read leaves the ledger below usable rather than failing the page.
    serverFetch<Wallet[]>('org-finance/mine').catch(() => [] as Wallet[]),
  ])

  // Summed per type AND currency across the whole filtered set: paise and
  // cents added together would not be an amount in either.
  const totals = 'items' in result ? ((result.meta as TransactionMeta).totalsByType ?? []) : []

  const columns: readonly TableColumn<TransactionRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => row.reference,
      renderSecondary: (row) => row.description ?? row.externalRef ?? undefined,
    },
    { key: 'type', header: 'Type', render: (row) => titleCase(row.type) },
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project?.title ?? '—',
      renderSecondary: (row) =>
        [row.project?.reference, row.build?.name].filter(Boolean).join(' · ') || undefined,
    },
    {
      key: 'counterparty',
      header: 'Paid to',
      render: (row) => (row.counterparty ? personName(row.counterparty) : '—'),
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
    },
  ]

  return (
    <AdminListPage
      root={ROOT}
      eyebrow="Operations"
      title="Transactions"
      description="Invoices, payments and other billing records for your organisation, recorded by the Crowd4Test team."
      crumbs={
        projectId
          ? [
              { label: 'Projects', href: '/app/customer/projects' },
              { label: 'Project', href: `/app/customer/projects/${projectId}` },
              { label: 'Transactions' },
            ]
          : [{ label: 'Transactions' }]
      }
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      hrefFor={pageHrefBuilder(BASE, { type, projectId, sort, order })}
      filtered={hasFilter([type, projectId])}
      permission="transaction.read"
      emptyIcon="credit-card"
      emptyTitle="No transactions yet"
      emptyDescription="Invoices and payments for your organisation appear here once the Crowd4Test team records them."
      toolbar={
        <ListFilters
          action={BASE}
          hidden={{ projectId }}
          selects={[
            {
              name: 'type',
              label: 'Type',
              options: TRANSACTION_TYPES,
              value: type,
              allLabel: 'All types',
            },
          ]}
          sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
        />
      }
      summary={
        wallets.length > 0 || totals.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            {wallets.map((w) => (
              <WalletSummary
                key={w.organisation.id}
                wallet={w}
                title={wallets.length > 1 ? `${w.organisation.name} wallet` : 'Your wallet'}
              />
            ))}
            {totals.length > 0 ? (
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
                {totals.map((t) => (
                  <div
                    key={`${t.type}-${t.currency}`}
                    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
                  >
                    <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                      {titleCase(t.type)}
                    </span>
                    <span
                      style={{
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 'var(--fw-semibold)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {formatMoney(t.amountMinor, t.currency)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null
      }
    />
  )
}

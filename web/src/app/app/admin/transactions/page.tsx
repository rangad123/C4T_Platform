import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Button } from '@/components/ds/core/Button'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, formatMoney, hasFilter, personName, titleCase } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'
import type { PageMeta } from '@/lib/api/types'

const PAGE_SIZE = 25
const BASE = '/app/admin/transactions'
// Tester payouts only -- customer invoices/payments/refunds are handled
// offline and are never offered or shown through this module (the
// underlying TransactionType enum and every existing CUSTOMER_* row are
// untouched on the API side; this is a UI scope, not a schema change).
const TYPES = ['TESTER_EARNING', 'TESTER_PAYOUT', 'ADJUSTMENT'] as const
const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED'] as const
const PAYMENT_METHODS = ['IND_BANK_ACCOUNT', 'NON_IND_BANK_ACCOUNT', 'PAYPAL', 'PAYTM'] as const
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
 * §21-27 — Indian / International / Pending Payments as real backend
 * categories (`?category=`), not three client-side filters over one flat
 * fetch. "All transactions" is the pre-existing flat view and stays the
 * default tab — nothing that already worked here is narrowed by adding the
 * other three.
 */
const SECTIONS = [
  { value: 'all', label: 'All transactions', icon: 'credit-card' },
  { value: 'indian', label: 'Indian', icon: 'building-2' },
  { value: 'international', label: 'International', icon: 'globe' },
  { value: 'pending', label: 'Pending payments', icon: 'clock' },
] as const

type Category = Exclude<(typeof SECTIONS)[number]['value'], 'all'>

function isCategory(value: string): value is Category {
  return value === 'indian' || value === 'international' || value === 'pending'
}

/**
 * Build the CSV export URL for the current filter set. Goes through the
 * catch-all Route Handler at `/app/admin/export/[...path]` so the export
 * stays same-origin (the route streams from the API on behalf of the browser).
 */
function buildExportHref(filters: Record<string, string | undefined>): string {
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
  /** `amountMinor - paidAmountMinor`, computed by the API — not stored. */
  outstandingMinor: string
  paidAmountMinor: string
  tdsAmountMinor: string | null
  paymentMethod: string | null
  buildOrContestRef: string | null
  currency: string
  description: string | null
  externalRef: string | null
  occurredAt: string
  settledAt: string | null
  organisation: { id: string; name: string } | null
  project: { id: string; reference: string } | null
  paymentAccount: {
    id: string
    paymentType: string
    bankName: string | null
    accountNumberLast4: string | null
    paypalEmailMasked: string | null
    paytmNumberLast4: string | null
  } | null
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
    section?: string
    paymentMethod?: string
    financeYear?: string
    month?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const section = resolveSection(SECTIONS, params.section)
  const category = isCategory(section) ? section : undefined
  // `selectedType` is what the user explicitly chose (or nothing) -- used
  // for the filter select's displayed value and the "is a filter applied"
  // check. `type`, sent to the API, is floored to every tester-payout type
  // when nothing was chosen, rather than left unscoped: an unscoped list
  // must never fall through to the flat underlying query, which would
  // otherwise also return CUSTOMER_* rows.
  const selectedType = TYPES.includes(params.type as (typeof TYPES)[number])
    ? params.type
    : undefined
  const type = selectedType ?? TYPES.join(',')
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number])
    ? params.status
    : undefined
  const paymentMethod = PAYMENT_METHODS.includes(
    params.paymentMethod as (typeof PAYMENT_METHODS)[number],
  )
    ? params.paymentMethod
    : undefined
  const financeYear = /^\d{4}$/.test(params.financeYear ?? '') ? params.financeYear : undefined
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month : undefined
  const sort = SORT_FIELDS.includes(params.sort as (typeof SORT_FIELDS)[number])
    ? params.sort
    : undefined
  const order = params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined
  const page = parsePage(params.page)

  // What the API's `listQuery` expects — keyed `category`.
  const apiQuery = { category, type, status, paymentMethod, financeYear, month, sort, order }
  // What a page URL (pagination, filter resubmission, CSV export) needs to
  // carry so the NEXT request reconstructs the same tab — keyed `section`,
  // matching what `resolveSection` reads back above. These are deliberately
  // two different keys for the same value: `category` only means something
  // to the API query; the page itself only ever reads `section` from the URL.
  const pageParams = { section: category, type: selectedType, status, paymentMethod, financeYear, month, sort, order }

  const result = await loadList<TransactionRow>('transactions', {
    page,
    limit: PAGE_SIZE,
    query: apiQuery,
  })

  const totals =
    'items' in result ? ((result.meta as TransactionMeta).totalsByType ?? []) : []

  const columns: readonly TableColumn<TransactionRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => row.reference,
      renderSecondary: (row) =>
        row.description ?? row.buildOrContestRef ?? row.externalRef ?? undefined,
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => titleCase(row.type),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'counterparty',
      header: category === 'pending' ? 'Tester' : 'Counterparty',
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
    // Paid / Outstanding matter most for Pending Payments (the whole point
    // of that tab), so they only take up table width there and on the
    // Indian tab, which the brief also asks for them on.
    ...(category === 'pending' || category === 'indian'
      ? ([
          {
            key: 'paid',
            header: 'Paid',
            align: 'right',
            render: (row) => (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatMoney(row.paidAmountMinor, row.currency)}
              </span>
            ),
          },
          {
            key: 'outstanding',
            header: 'Outstanding',
            align: 'right',
            render: (row) => (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatMoney(row.outstandingMinor, row.currency)}
              </span>
            ),
          },
        ] satisfies TableColumn<TransactionRow>[])
      : []),
    ...(category === 'indian'
      ? ([
          {
            key: 'tds',
            header: 'TDS',
            align: 'right',
            render: (row) =>
              row.tdsAmountMinor ? (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatMoney(row.tdsAmountMinor, row.currency)}
                </span>
              ) : (
                '—'
              ),
          },
        ] satisfies TableColumn<TransactionRow>[])
      : []),
    ...(category === 'international' || category === 'pending'
      ? ([
          {
            key: 'paymentMethod',
            header: 'Payment method',
            render: (row) => (row.paymentMethod ? titleCase(row.paymentMethod) : '—'),
            renderSecondary: (row) =>
              row.paymentAccount
                ? row.paymentAccount.bankName ??
                  row.paymentAccount.paypalEmailMasked ??
                  (row.paymentAccount.accountNumberLast4
                    ? `•••• ${row.paymentAccount.accountNumberLast4}`
                    : undefined) ??
                  (row.paymentAccount.paytmNumberLast4
                    ? `•••• ${row.paymentAccount.paytmNumberLast4}`
                    : undefined)
                : undefined,
          },
        ] satisfies TableColumn<TransactionRow>[])
      : []),
    {
      key: 'occurred',
      header: 'Occurred',
      align: 'right',
      render: (row) => formatDate(row.occurredAt),
      renderSecondary: (row) => (row.settledAt ? `Settled ${formatDate(row.settledAt)}` : undefined),
    },
  ]

  const CATEGORY_DESCRIPTION: Record<(typeof SECTIONS)[number]['value'], string> = {
    all: 'Customer invoices and tester payouts, recorded by hand. Nothing here moves money — the ledger is bookkeeping, and settlement happens outside the platform.',
    indian:
      'Settled transactions paid out to an Indian bank account or Paytm — or, for rows recorded before a payment method was attached, priced in INR.',
    international:
      'Settled transactions paid out to an international bank account or PayPal — or, for rows recorded before a payment method was attached, priced outside INR.',
    pending:
      'Every transaction still awaiting approval or payout, regardless of currency or payment method — this is the outstanding-amounts view.',
  }

  return (
    <AdminListPage
      eyebrow="Operations"
      title="Transactions"
      description={CATEGORY_DESCRIPTION[section]}
      crumbs={[{ label: 'Transactions' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `${BASE}/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, pageParams)}
      filtered={hasFilter([selectedType, status, paymentMethod, financeYear, month])}
      permission="transaction.read"
      emptyIcon="credit-card"
      emptyTitle={
        category === 'pending'
          ? 'Nothing pending'
          : category === 'indian'
            ? 'No Indian transactions yet'
            : category === 'international'
              ? 'No international transactions yet'
              : 'No transactions yet'
      }
      emptyDescription="Record an invoice or a payout and it appears here."
      tabs={<SectionTabs basePath={BASE} tabs={SECTIONS} active={section} />}
      toolbar={
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <ListFilters
              action={BASE}
              hidden={{ section: category }}
              selects={[
                { name: 'type', label: 'Type', options: TYPES, value: selectedType, allLabel: 'All types' },
                {
                  name: 'status',
                  label: 'Status',
                  options: STATUSES,
                  value: status,
                  allLabel: 'All statuses',
                },
                {
                  name: 'paymentMethod',
                  label: 'Payment method',
                  options: PAYMENT_METHODS,
                  value: paymentMethod,
                  allLabel: 'All methods',
                },
              ]}
              texts={[
                ...(category === 'indian' || category === 'pending'
                  ? [
                      {
                        name: 'financeYear',
                        label: 'Finance year',
                        value: financeYear,
                        placeholder: '2025',
                        maxLength: 4,
                      },
                    ]
                  : []),
                ...(category === 'pending'
                  ? [
                      {
                        name: 'month',
                        label: 'Month',
                        value: month,
                        placeholder: '2026-03',
                        maxLength: 7,
                      },
                    ]
                  : []),
              ]}
              sort={{ name: 'sort', orderName: 'order', options: SORT_OPTIONS, value: sort, order }}
            />
          </div>
          <Button
            href={buildExportHref(apiQuery)}
            prefetch={false}
            variant="secondary"
            iconLeft="download"
          >
            Export CSV
          </Button>
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

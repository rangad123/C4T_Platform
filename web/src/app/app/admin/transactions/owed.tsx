import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Button } from '@/components/ds/core/Button'
import type { TableColumn } from '@/components/ds/admin/Table'
import type { ReactNode } from 'react'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, formatMoney, hasFilter, personName, titleCase } from '@/lib/admin/format'
import { PAYMENT_METHODS, isOneOf } from '@/lib/domain/enums'

/**
 * The Pending payments tab — who is owed what.
 *
 * One row per tester and currency: everything credited to them minus everything
 * already paid out. It is not a filter over ledger rows, because an earning row
 * never says whether it has since been paid; the balance is the only honest
 * answer. A tester with an open payout request leads the list, and the row's
 * button opens the payout form with the tester, amount and request filled in —
 * recording that payout closes the request.
 */

const BASE = '/app/admin/transactions'
const PAGE_SIZE = 25

interface OwedRow {
  testerId: string
  testerProfileId: string | null
  firstName: string | null
  lastName: string | null
  countryCode: string | null
  currency: string
  /** Minor units, as a string. */
  owedMinor: string
  paymentAccount: {
    paymentType: string
    bankName: string | null
    accountNumberLast4: string | null
    paypalEmailMasked: string | null
    paytmNumberLast4: string | null
  } | null
  openRequest: { id: string; amountMinor: string; createdAt: string } | null
}

/** `150050` → `1500.50`, by string surgery — the payout form takes major units. */
function toMajor(minor: string): string {
  const negative = minor.startsWith('-')
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

function methodDetails(account: NonNullable<OwedRow['paymentAccount']>): string | undefined {
  return (
    account.bankName ??
    account.paypalEmailMasked ??
    (account.accountNumberLast4 ? `•••• ${account.accountNumberLast4}` : undefined) ??
    (account.paytmNumberLast4 ? `•••• ${account.paytmNumberLast4}` : undefined)
  )
}

function recordPaymentHref(row: OwedRow): string {
  const amountMinor = row.openRequest?.amountMinor ?? row.owedMinor
  const sp = new URLSearchParams({
    type: 'TESTER_PAYOUT',
    counterpartyId: row.testerId,
    amount: toMajor(amountMinor),
    currency: row.currency,
  })
  if (row.paymentAccount) sp.set('paymentMethod', row.paymentAccount.paymentType)
  if (row.openRequest) sp.set('payoutRequestId', row.openRequest.id)
  return `${BASE}/new?${sp.toString()}`
}

export async function OwedPayments({
  params,
  tabs,
}: {
  params: { page?: string; search?: string; paymentMethod?: string }
  tabs: ReactNode
}) {
  // An empty box is "no filter": the list read, the page links and the
  // filter form all treat an empty string as absent.
  const search = params.search?.trim() ?? ''
  const paymentMethod = isOneOf(
    PAYMENT_METHODS,
    params.paymentMethod as (typeof PAYMENT_METHODS)[number],
  )
    ? params.paymentMethod
    : undefined
  const page = parsePage(params.page)

  const result = await loadList<OwedRow>('transactions/owed', {
    page,
    limit: PAGE_SIZE,
    query: { search, paymentMethod },
  })

  const columns: readonly TableColumn<OwedRow>[] = [
    {
      key: 'tester',
      header: 'Tester',
      render: (row) => personName(row) || '—',
      renderSecondary: (row) => row.countryCode ?? undefined,
    },
    {
      key: 'owed',
      header: 'Owed',
      align: 'right',
      render: (row) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatMoney(row.owedMinor, row.currency)}
        </span>
      ),
    },
    {
      key: 'request',
      header: 'Payout request',
      render: (row) =>
        row.openRequest ? formatMoney(row.openRequest.amountMinor, row.currency) : '—',
      renderSecondary: (row) =>
        row.openRequest ? `Asked ${formatDate(row.openRequest.createdAt)}` : undefined,
    },
    {
      key: 'method',
      header: 'Payment method',
      render: (row) => (row.paymentAccount ? titleCase(row.paymentAccount.paymentType) : '—'),
      renderSecondary: (row) =>
        row.paymentAccount ? methodDetails(row.paymentAccount) : 'No payment details yet',
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) => (
        <Button href={recordPaymentHref(row)} variant="secondary" size="sm" iconLeft="plus">
          Record payment
        </Button>
      ),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Operations"
      title="Transactions"
      description="What each tester is still owed — everything credited to them minus everything already paid out. A tester who has asked to be paid is listed first. Recording the payout closes their request."
      crumbs={[{ label: 'Transactions' }]}
      result={result}
      columns={columns}
      rowKey={(row) => `${row.testerId}-${row.currency}`}
      hrefFor={pageHrefBuilder(BASE, { section: 'pending', search, paymentMethod })}
      filtered={hasFilter([search, paymentMethod])}
      permission="transaction.read"
      emptyIcon="credit-card"
      emptyTitle="Nobody is owed anything"
      emptyDescription="Credit a tester for their work and the balance appears here until you record a payout."
      tabs={tabs}
      toolbar={
        <ListFilters
          action={BASE}
          hidden={{ section: 'pending' }}
          selects={[
            {
              name: 'paymentMethod',
              label: 'Payment method',
              options: PAYMENT_METHODS,
              value: paymentMethod,
              allLabel: 'All methods',
            },
          ]}
          texts={[{ name: 'search', label: 'Tester', value: search, placeholder: 'Name' }]}
        />
      }
    />
  )
}

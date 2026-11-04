import { AdminListPage } from '@/components/admin/AdminListPage'
import { ListFilters } from '@/components/admin/ListFilters'
import { Button } from '@/components/ds/core/Button'
import type { TableColumn } from '@/components/ds/admin/Table'
import type { ReactNode } from 'react'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, formatMoney, hasFilter, personName, titleCase } from '@/lib/admin/format'
import { PAYMENT_METHODS, isOneOf } from '@/lib/domain/enums'
import { recordTransferHref } from '@/lib/admin/payouts'

/**
 * The Pending payments tab — who is owed what.
 *
 * One row per tester and currency: everything credited to them minus everything
 * already paid out. It is not a filter over ledger rows, because an earning row
 * never says whether it has since been paid; the balance is the only honest
 * answer. A tester with an open payout request leads the list. "Record bank
 * transfer" opens the form with the tester and amount filled in: for a tester
 * who asked, the request too, and recording the transfer closes it; for one
 * who has not, the amount available, which goes straight to Paid out.
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
  /** When the most recent credit was earned; the list runs newest first. */
  lastCreditAt: string | null
  paymentAccount: {
    paymentType: string
    bankName: string | null
    accountNumberLast4: string | null
    paypalEmailMasked: string | null
    paytmNumberLast4: string | null
  } | null
  openRequest: { id: string; amountMinor: string; createdAt: string } | null
}

function methodDetails(account: NonNullable<OwedRow['paymentAccount']>): string | undefined {
  return (
    account.bankName ??
    account.paypalEmailMasked ??
    (account.accountNumberLast4 ? `•••• ${account.accountNumberLast4}` : undefined) ??
    (account.paytmNumberLast4 ? `•••• ${account.paytmNumberLast4}` : undefined)
  )
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
      key: 'lastCredit',
      header: 'Last credited',
      render: (row) => (row.lastCreditAt ? formatDate(row.lastCreditAt) : '—'),
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
      // Against the request when there is one; otherwise straight to Paid out.
      render: (row) =>
        row.openRequest || row.owedMinor !== '0' ? (
          <Button
            href={recordTransferHref({
              testerId: row.testerId,
              amountMinor: row.openRequest?.amountMinor ?? row.owedMinor,
              currency: row.currency,
              requestId: row.openRequest?.id,
              paymentType: row.paymentAccount?.paymentType,
            })}
            variant="secondary"
            size="sm"
            iconLeft="banknote"
          >
            Record bank transfer
          </Button>
        ) : null,
    },
  ]

  return (
    <AdminListPage
      eyebrow="Operations"
      title="Transactions"
      description="What each tester is still owed — everything credited to them minus everything already paid out. Testers who have asked to be paid come first. Record a bank transfer once the money has been sent; for a tester who asked, that closes their request."
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

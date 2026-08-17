import type { CSSProperties } from 'react'
import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Icon } from '@/components/ds/core/Icon'
import { Logo } from '@/components/ds/core/Logo'
import { Button } from '@/components/ds/core/Button'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { logoutAction } from '@/lib/auth/actions'
import { formatDate, formatMoney, titleCase } from '@/lib/admin/format'

interface EarningsSummary {
  currency: string
  earnedTotalMinor: string
  earnedApprovedMinor: string
  earnedPendingMinor: string
  paidOutMinor: string
}

interface TransactionRow {
  id: string
  reference: string
  type: string
  status: string
  amountMinor: string
  currency: string
  description: string | null
  project: { id: string; reference: string; title: string } | null
  occurredAt: string
}

const STAT_TILE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  padding: 'var(--space-5)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--surface-raised)',
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={STAT_TILE_STYLE}>
      <span
        className="c4t-eyebrow"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 'var(--type-heading-md-size)',
          fontWeight: 'var(--fw-semibold)',
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      {hint ? (
        <span style={{ fontSize: 'var(--type-body-sm-size)', color: 'var(--text-secondary)' }}>
          {hint}
        </span>
      ) : undefined}
    </div>
  )
}

/**
 * `/app/tester` — the tester home.
 *
 * The landing page of the tester portal, and its earnings view (§21 "Tester
 * Account / Finance"). Every number here is a live read from the same ledger
 * the admin Transactions list uses — `GET /v1/transactions/summary/mine` and
 * `GET /v1/transactions`, both auto-scoped to the caller by
 * `transactionScope` — nothing on this page is mocked.
 *
 * The rest of the portal hangs off the buttons in the header: bug reporting
 * with evidence upload (`/bugs`), profile self-service (`/profile`), and the
 * announcements feed (`/announcements`).
 *
 * What is deliberately NOT shown: a Credit Fund / Release Fund split, a
 * payment method, or a TDS figure. The schema has no two-stage credit/release
 * semantics and no payment-method or tax-deduction fields, so rendering those
 * would misstate an account holder's actual position. "Available balance" is
 * computed as approved earnings minus paid-out amounts, which is the only
 * reading of "balance" this ledger can actually support — and it is labelled
 * with that formula rather than presented as an unqualified number.
 */
export default async function TesterHomePage() {
  const user = await requireRole(['TESTER'], '/app/tester')

  const summary = await serverFetchOrNull<EarningsSummary>('transactions/summary/mine')
  const transactions = await serverFetchOrNull<readonly TransactionRow[]>(
    'transactions?limit=50&sort=occurredAt&order=desc',
  )

  const currency = summary?.currency ?? 'INR'
  const availableBalanceMinor =
    summary && Number.isFinite(Number(summary.earnedApprovedMinor)) && Number.isFinite(Number(summary.paidOutMinor))
      ? String(Number(summary.earnedApprovedMinor) - Number(summary.paidOutMinor))
      : null

  const columns: readonly TableColumn<TransactionRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => row.reference,
      renderSecondary: (row) => row.description ?? row.project?.reference ?? undefined,
    },
    { key: 'type', header: 'Type', render: (row) => titleCase(row.type) },
    { key: 'status', header: 'Status', render: (row) => titleCase(row.status) },
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
      key: 'date',
      header: 'Date',
      align: 'right',
      render: (row) => formatDate(row.occurredAt),
    },
  ]

  return (
    <main
      id="main"
      style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: 'var(--space-9) var(--space-7)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-8)',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <Logo size={24} withWordmark />
          </div>
          <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
            Tester
          </span>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            Welcome back{user.firstName ? `, ${user.firstName}` : ''}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Button href="/app/tester/bugs" variant="primary" iconLeft="clipboard-check">
            Bugs
          </Button>
          <Button href="/app/tester/announcements" variant="secondary" iconLeft="message-square">
            Announcements
          </Button>
          <Button href="/app/tester/profile" variant="secondary" iconLeft="user-check">
            Your profile
          </Button>
          <form action={logoutAction}>
            <Button type="submit" variant="secondary" iconLeft="log-out">
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <h2
          style={{
            margin: 0,
            fontSize: 'var(--type-body-md-size)',
            fontWeight: 'var(--fw-semibold)',
            color: 'var(--text-primary)',
          }}
        >
          Earnings
        </h2>
        {summary ? (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <StatTile
                label="Available balance"
                value={formatMoney(availableBalanceMinor ?? '0', currency)}
                hint="Approved earnings not yet paid out"
              />
              <StatTile
                label="Total earned"
                value={formatMoney(summary.earnedTotalMinor, currency)}
              />
              <StatTile
                label="Pending review"
                value={formatMoney(summary.earnedPendingMinor, currency)}
              />
              <StatTile label="Paid out" value={formatMoney(summary.paidOutMinor, currency)} />
            </div>
            <p style={{ margin: 0, fontSize: 'var(--type-body-sm-size)', color: 'var(--text-muted)' }}>
              <Icon name="info" size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              A separate credit/release split, payment method, and tax-deduction figure are not
              tracked in this account yet — this page shows exactly what the ledger records today.
            </p>
          </>
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Could not load your earnings"
            description="The service is unreachable. Refresh in a moment."
          />
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <h2
          style={{
            margin: 0,
            fontSize: 'var(--type-body-md-size)',
            fontWeight: 'var(--fw-semibold)',
            color: 'var(--text-primary)',
          }}
        >
          Transaction history
        </h2>
        {!transactions || transactions.length === 0 ? (
          <EmptyState
            icon="credit-card"
            title="No transactions yet"
            description="Earnings and payouts appear here once a project you tested on records one."
          />
        ) : (
          <Table
            ariaLabel="Transaction history"
            columns={columns}
            rows={transactions}
            rowKey={(row) => row.id}
          />
        )}
      </section>

      <section
        style={{
          padding: 'var(--space-5)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-card)',
          background: 'var(--surface-sunken)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
          Your workspace
        </span>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
          Everything above is live: your earnings and transaction history, your profile and
          devices, filing bug reports with screenshots or recordings attached, and announcements
          from the platform and from projects you are on.
        </p>
      </section>
    </main>
  )
}

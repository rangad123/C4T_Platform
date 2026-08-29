import type { CSSProperties } from 'react'
import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Topbar } from '@/components/admin/Topbar'
import { Card, CardGrid } from '@/components/admin/Card'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Icon } from '@/components/ds/core/Icon'
import { Button } from '@/components/ds/core/Button'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { formatDate, formatMoney, titleCase } from '@/lib/admin/format'
import { requestPayoutAction } from './actions'

const ROOT = { label: 'Tester', href: '/app/tester' }

interface EarningsSummary {
  currency: string
  earnedTotalMinor: string
  earnedApprovedMinor: string
  earnedReleasedMinor: string
  earnedPendingMinor: string
  paidOutMinor: string
  tdsWithheldMinor: string
}

/** `GET /v1/transactions/payouts/mine` — the authoritative payout state. */
interface PayoutState {
  currency: string
  availableMinor: string
  /** Everything credited — the legacy "Credit Fund". */
  creditedMinor: string
  /** The released subset — the legacy "Release Fund". */
  releasedMinor: string
  /** Credited but held back, so not withdrawable. */
  awaitingReleaseMinor: string
  minimumMinor: string
  hasPaymentAccount: boolean
  meetsMinimum: boolean
  openRequest: {
    id: string
    reference: string
    amountMinor: string
    status: string
    occurredAt: string
  } | null
  canRequest: boolean
}

const NOTICES: Record<string, NoticeCopy> = {
  'payout-requested': {
    tone: 'success',
    message:
      'Your payout request has been submitted. You will see it move to paid once it settles.',
  },
  'payout-rejected': {
    tone: 'warning',
    message:
      'That request could not be submitted. Check the balance and payment details shown below, then try again.',
  },
  'payout-failed': {
    tone: 'error',
    message: 'We could not submit that request. Try again in a moment.',
  },
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

/** A row of `GET /v1/projects/my-assignments` — the tester's own standing. */
interface AssignmentRow {
  status: string
  invitedAt: string
  project: {
    id: string
    reference: string
    title: string
    status: string
    endDate: string | null
    organisation: { id: string; name: string } | null
  } | null
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
      <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
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
 * The rest of the portal hangs off the sidebar: bug reporting with evidence
 * upload (`/bugs`), profile self-service (`/profile`), and the announcements
 * feed (`/announcements`).
 *
 * What is deliberately NOT shown: a Credit Fund / Release Fund split, a
 * payment method, or a TDS figure. The schema has no two-stage credit/release
 * semantics and no payment-method or tax-deduction fields, so rendering those
 * would misstate an account holder's actual position. "Available balance" is
 * computed as approved earnings minus paid-out amounts, which is the only
 * reading of "balance" this ledger can actually support — and it is labelled
 * with that formula rather than presented as an unqualified number.
 */
export default async function TesterHomePage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>
}) {
  const user = await requireRole(['TESTER'], '/app/tester')
  const { notice } = await searchParams

  const [summary, transactions, assignments, payout] = await Promise.all([
    serverFetchOrNull<EarningsSummary>('transactions/summary/mine'),
    serverFetchOrNull<readonly TransactionRow[]>(
      'transactions?limit=50&sort=occurredAt&order=desc',
    ),
    serverFetchOrNull<readonly AssignmentRow[]>('projects/my-assignments?limit=6'),
    serverFetchOrNull<PayoutState>('transactions/payouts/mine'),
  ])

  /**
   * An invitation needs answering before anything else on this page matters,
   * so those sort to the front. `REMOVED`/`DECLINED` rows are dropped: they
   * are history, and history lives on the Projects page.
   */
  const liveAssignments = (assignments ?? [])
    .filter((a) => a.project !== null && a.status !== 'REMOVED' && a.status !== 'DECLINED')
    .sort((a, b) => (a.status === 'INVITED' ? -1 : 0) - (b.status === 'INVITED' ? -1 : 0))
  const openInvitations = liveAssignments.filter((a) => a.status === 'INVITED').length

  const currency = summary?.currency ?? 'INR'

  /**
   * The balance comes from the API, not from arithmetic here.
   *
   * This page used to derive it as `earnedApproved − paidOut`, which counts
   * only payouts that have already SETTLED. A request still pending was
   * therefore invisible, and the figure told a tester they could withdraw
   * money they had already asked for. `payouts/mine` subtracts every payout
   * that has not been cancelled or failed, which is the number the request
   * endpoint itself enforces against.
   */
  const availableBalanceMinor = payout?.availableMinor ?? null

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
    <>
      <Topbar root={ROOT} crumbs={[{ label: 'Dashboard' }]} />
      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          maxWidth: 960,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-8)',
        }}
      >
        <Notice code={notice} notices={NOTICES} />

        <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
            Dashboard
          </span>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            Welcome back{user.firstName ? `, ${user.firstName}` : ''}
          </h1>
          {openInvitations > 0 ? (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              You have {openInvitations} invitation{openInvitations === 1 ? '' : 's'} waiting on an
              answer.
            </p>
          ) : null}
        </header>

        {/*
        Work first, money second. A tester opens this page to find out what
        they are meant to be doing; the ledger below is the record of what
        they already did.
      */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 'var(--type-body-md-size)',
                fontWeight: 'var(--fw-semibold)',
                color: 'var(--text-primary)',
              }}
            >
              Your projects
            </h2>
            <Button href="/app/tester/projects" variant="link" size="sm" iconRight="arrow-right">
              View all projects
            </Button>
          </div>

          {liveAssignments.length === 0 ? (
            <EmptyState
              icon="briefcase"
              title="No projects yet"
              description="When a project invites you to test, it appears here."
            />
          ) : (
            <CardGrid min={260}>
              {liveAssignments.map((a) => (
                <Card
                  key={a.project!.id}
                  href={`/app/tester/projects/${a.project!.id}`}
                  title={a.project!.title}
                  meta={[a.project!.reference, a.project!.organisation?.name]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <StatusBadge status={a.status} />
                    {a.project!.endDate ? (
                      <span
                        style={{ color: 'var(--text-muted)', fontSize: 'var(--type-caption-size)' }}
                      >
                        Ends {formatDate(a.project!.endDate)}
                      </span>
                    ) : null}
                  </div>
                </Card>
              ))}
            </CardGrid>
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
                  label="Available to withdraw"
                  value={formatMoney(availableBalanceMinor ?? '0', currency)}
                  hint="Released funds not yet paid out"
                />
                {/* The legacy Credit Fund / Release Fund split. Credited is what
                  the tester has earned and been approved for; awaiting release
                  is the part an operator still holds back. Showing only one
                  number here is what used to imply approved money was
                  withdrawable. */}
                <StatTile
                  label="Credited"
                  value={formatMoney(payout?.creditedMinor ?? summary.earnedTotalMinor, currency)}
                  hint="Approved earnings, released or not"
                />
                <StatTile
                  label="Awaiting release"
                  value={formatMoney(payout?.awaitingReleaseMinor ?? '0', currency)}
                  hint="Credited, not yet withdrawable"
                />
                <StatTile
                  label="Pending review"
                  value={formatMoney(summary.earnedPendingMinor, currency)}
                  hint="Not yet approved"
                />
                <StatTile label="Paid out" value={formatMoney(summary.paidOutMinor, currency)} />
                <StatTile
                  label="TDS withheld"
                  value={formatMoney(summary.tdsWithheldMinor, currency)}
                  hint="Tax deducted on your behalf"
                />
              </div>

              {/* ── Requesting a payout ──────────────────────────────────────
                Every branch below is driven by `payout`, which the API
                computes. The button is never rendered enabled on a state the
                server would reject — and the server re-checks all of it
                anyway, because a disabled button is not authorisation. */}
              {payout ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-4)',
                    flexWrap: 'wrap',
                    padding: 'var(--space-5)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--surface-raised)',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <span
                      style={{
                        fontSize: 'var(--type-body-sm-size)',
                        fontWeight: 'var(--fw-semibold)',
                      }}
                    >
                      {payout.openRequest ? 'Payout in progress' : 'Request a payout'}
                    </span>
                    <span
                      style={{
                        fontSize: 'var(--type-body-sm-size)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {payout.openRequest
                        ? `${formatMoney(payout.openRequest.amountMinor, currency)} requested on ${formatDate(payout.openRequest.occurredAt)} · ${titleCase(payout.openRequest.status)}`
                        : !payout.hasPaymentAccount
                          ? 'Add your payment details before you can be paid.'
                          : !payout.meetsMinimum
                            ? `You can request a payout once your balance reaches ${formatMoney(payout.minimumMinor, currency)}.`
                            : `${formatMoney(payout.availableMinor, currency)} is ready to be paid to your saved account.`}
                    </span>
                    {/* Distinguishes "you have earned nothing" from "your money
                      is credited but an operator has not released it" — two
                      very different things to a tester chasing a payment. */}
                    {!payout.openRequest &&
                    !payout.meetsMinimum &&
                    payout.awaitingReleaseMinor !== '0' ? (
                      <span
                        style={{ fontSize: 'var(--type-body-sm-size)', color: 'var(--text-muted)' }}
                      >
                        {formatMoney(payout.awaitingReleaseMinor, currency)} is credited but not yet
                        released.
                      </span>
                    ) : null}
                  </div>

                  {payout.openRequest ? null : payout.hasPaymentAccount ? (
                    <form action={requestPayoutAction}>
                      <SubmitButton
                        variant="primary"
                        disabled={!payout.canRequest}
                        pendingLabel="Requesting…"
                      >
                        Request {formatMoney(payout.availableMinor, currency)}
                      </SubmitButton>
                    </form>
                  ) : (
                    <Button href="/app/tester/profile?section=payment" variant="secondary">
                      Add payment details
                    </Button>
                  )}
                </div>
              ) : null}

              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--type-body-sm-size)',
                  color: 'var(--text-muted)',
                }}
              >
                <Icon name="info" size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                Earnings are approved first, then released for withdrawal. Only released funds can
                be paid out, so a credited balance is not always available yet.
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
          <p
            style={{
              margin: 0,
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            Everything above is live: your earnings and transaction history, your profile and
            devices, filing bug reports with screenshots or recordings attached, and announcements
            from the platform and from projects you are on.
          </p>
        </section>
      </main>
    </>
  )
}

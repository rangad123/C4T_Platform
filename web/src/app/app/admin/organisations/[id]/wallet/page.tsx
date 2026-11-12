import { randomUUID } from 'node:crypto'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import {
  WalletSummary,
  WALLET_MOVE_LABELS,
  planLabel,
  type Wallet,
  type WalletBuild,
  type WalletPlan,
  type WalletRow,
} from '@/components/finance/WalletSummary'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { hasPermission, requirePermission } from '@/lib/auth/session'
import { formatDate, formatMoney, personName } from '@/lib/admin/format'
import {
  assignOrganisationPlan,
  lockBuildFunds,
  recordTopUp,
  releaseBuildFunds,
  saveBuildReward,
} from './actions'

/**
 * `/app/admin/organisations/[id]/wallet` — the organisation's wallet.
 *
 * An admin records a customer's top-up (a customer payment row), locks part
 * of the balance for a build (escrow), and releases what is left once the
 * build is closed. A tester earning recorded on a funded build is paid out of
 * its lock by the API. Every move is a ledger row; the history shows them.
 * Recording only: no gateway, no automatic billing.
 */

const NOTICES: Record<string, NoticeCopy> = {
  'topped-up': { tone: 'success', message: 'Top-up recorded. The balance is updated.' },
  locked: { tone: 'success', message: 'Funds locked for the build.' },
  released: { tone: 'success', message: 'What was left locked is back in the balance.' },
  'reward-saved': { tone: 'success', message: 'Tester reward saved. Testers see it on the build.' },
  'plan-assigned': { tone: 'success', message: 'Plan recorded for this organisation.' },
}

interface PlanOption {
  id: string
  name: string
  archivedAt: string | null
}

const row = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-4)',
  alignItems: 'flex-end',
} as const

export default async function OrganisationWalletPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ notice?: string; error?: string }>
}) {
  const user = await requirePermission('transaction.read')
  const canWrite = hasPermission(user, 'transaction.write')
  const { id } = await params
  const { notice, error } = await searchParams

  let wallet: Wallet
  try {
    wallet = await serverFetch<Wallet>(`org-finance/organisations/${id}`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound()
    throw e
  }
  const plans = canWrite
    ? await serverFetch<PlanOption[]>('org-finance/plans').catch(() => [] as PlanOption[])
    : []
  const today = new Date().toISOString().slice(0, 10)
  const cur = wallet.currency

  const historyColumns: readonly TableColumn<WalletRow>[] = [
    {
      key: 'move',
      header: 'Move',
      render: (r) => WALLET_MOVE_LABELS[r.walletMove],
      renderSecondary: (r) => r.reference,
    },
    {
      key: 'for',
      header: 'For',
      render: (r) => (r.build ? `${r.project?.title ?? ''} · ${r.build.name}` : '—'),
      renderSecondary: (r) =>
        r.counterparty ? personName(r.counterparty) : (r.externalRef ?? r.description ?? undefined),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (r) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatMoney(r.amountMinor, r.currency)}
        </span>
      ),
    },
    { key: 'date', header: 'Occurred', align: 'right', render: (r) => formatDate(r.occurredAt) },
  ]

  return (
    <DetailShell
      crumbs={[
        { label: 'Organisations', href: '/app/admin/organisations' },
        { label: wallet.organisation.name, href: `/app/admin/organisations/${id}` },
        { label: 'Wallet' },
      ]}
      eyebrow="Finance"
      title={`${wallet.organisation.name} wallet`}
      subtitle="Top-ups, funds locked per build, and the plan this organisation holds."
    >
      <Notice code={notice} notices={NOTICES} />
      {error ? (
        <p
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            margin: 0,
            padding: 'var(--space-4) var(--space-5)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-card)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <Icon name="alert-triangle" size={16} />
          <span>{error.slice(0, 240)}</span>
        </p>
      ) : null}

      <WalletSummary wallet={wallet} />

      {canWrite ? (
        <Panel
          title="Record a top-up"
          description={`A payment the customer made. It is recorded as a customer payment and added to the balance, in ${cur}.`}
        >
          <form
            action={recordTopUp}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="orgId" value={id} />
            <input type="hidden" name="currency" value={cur} />
            <input type="hidden" name="key" value={randomUUID()} />
            <div style={row}>
              <Field
                label="Amount"
                htmlFor="topup-amount"
                required
                hint="Major units, e.g. 25000.00"
              >
                <Input
                  id="topup-amount"
                  name="amount"
                  required
                  inputMode="decimal"
                  autoComplete="off"
                />
              </Field>
              <Field label="Received on" htmlFor="topup-date">
                <Input id="topup-date" name="occurredAt" type="date" defaultValue={today} />
              </Field>
              <Field label="Bank reference" htmlFor="topup-ref" hint="UTR or invoice number.">
                <Input id="topup-ref" name="externalRef" maxLength={120} autoComplete="off" />
              </Field>
              <Field label="Note" htmlFor="topup-note">
                <Input id="topup-note" name="description" maxLength={1000} autoComplete="off" />
              </Field>
            </div>
            <div>
              <SubmitButton iconLeft="plus" pendingLabel="Recording…">
                Record top-up
              </SubmitButton>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Builds"
        description="Lock funds for a build before testing starts. Tester earnings on it are paid from the lock. Release what is left once the build is closed."
      >
        {wallet.builds.length === 0 ? (
          <EmptyState
            icon="credit-card"
            title="No builds yet"
            description="This organisation has no builds to fund."
          />
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {wallet.builds.map((b, i) => (
              <BuildFunding
                key={b.id}
                build={b}
                orgId={id}
                currency={cur}
                canWrite={canWrite}
                first={i === 0}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Plan" description={`Current: ${planLabel(wallet.currentPlan)}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          {canWrite ? (
            plans.filter((p) => !p.archivedAt).length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                No plans are defined yet.{' '}
                <Button href="/app/admin/organisations/plans" variant="link">
                  Define plans
                </Button>
              </p>
            ) : (
              <form
                action={assignOrganisationPlan}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
              >
                <input type="hidden" name="orgId" value={id} />
                <div style={row}>
                  <Field label="Plan" htmlFor="plan-id" required>
                    <Select
                      id="plan-id"
                      name="planId"
                      required
                      placeholder="Choose a plan"
                      options={plans
                        .filter((p) => !p.archivedAt)
                        .map((p) => ({ value: p.id, label: p.name }))}
                    />
                  </Field>
                  <Field label="Starts" htmlFor="plan-start" required>
                    <Input
                      id="plan-start"
                      name="startDate"
                      type="date"
                      required
                      defaultValue={today}
                    />
                  </Field>
                  <Field label="Ends" htmlFor="plan-end" hint="Leave blank for open-ended.">
                    <Input id="plan-end" name="endDate" type="date" />
                  </Field>
                  <Field label="Projects left" htmlFor="plan-projects">
                    <Input id="plan-projects" name="remainingProjects" inputMode="numeric" />
                  </Field>
                  <Field label="Private testers left" htmlFor="plan-testers">
                    <Input id="plan-testers" name="remainingPrivateTesters" inputMode="numeric" />
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
                  <SubmitButton pendingLabel="Saving…">Record plan</SubmitButton>
                  <Button href="/app/admin/organisations/plans" variant="link">
                    Manage plans
                  </Button>
                </div>
              </form>
            )
          ) : null}
          {wallet.plans.length > 0 ? (
            <Table<WalletPlan>
              ariaLabel="Plan history"
              rows={wallet.plans}
              rowKey={(p) => p.id}
              columns={[
                { key: 'plan', header: 'Plan', render: (p) => p.plan.name },
                {
                  key: 'period',
                  header: 'Period',
                  render: (p) =>
                    `${formatDate(p.startDate)} – ${p.endDate ? formatDate(p.endDate) : 'open-ended'}`,
                },
                {
                  key: 'quota',
                  header: 'Left',
                  align: 'right',
                  render: (p) =>
                    `${p.remainingProjects ?? '—'} projects · ${p.remainingPrivateTesters ?? '—'} testers`,
                },
              ]}
            />
          ) : null}
        </div>
      </Panel>

      <Panel title="History" description="The last 50 wallet moves, newest first." flush>
        <Table<WalletRow>
          ariaLabel="Wallet history"
          rows={wallet.history}
          rowKey={(r) => r.id}
          columns={historyColumns}
          emptyState={
            <EmptyState
              variant="inline"
              icon="banknote"
              title="No wallet moves yet"
              description="Record a top-up to start."
            />
          }
        />
      </Panel>
    </DetailShell>
  )
}

function BuildFunding({
  build: b,
  orgId,
  currency,
  canWrite,
  first,
}: {
  build: WalletBuild
  orgId: string
  currency: string
  canWrite: boolean
  first: boolean
}) {
  const released = b.releasedMinor !== '0'
  const closed = b.status === 'CLOSED'
  const reward = b.testerRewardMinor ? (Number(b.testerRewardMinor) / 100).toFixed(2) : ''
  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        padding: 'var(--space-5) 0',
        borderTop: first ? 'none' : '1px solid var(--border-subtle)',
      }}
    >
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'center' }}
      >
        <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-primary)' }}>
          {b.project.title} · {b.name}
        </span>
        <StatusBadge status={b.status} />
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
          {formatMoney(b.remainingMinor, currency)} locked · {formatMoney(b.drawnMinor, currency)}{' '}
          paid to testers
          {released ? ` · ${formatMoney(b.releasedMinor, currency)} released` : ''}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          Reward per accepted bug:{' '}
          {b.testerRewardMinor
            ? formatMoney(b.testerRewardMinor, b.rewardsCurrency ?? currency)
            : 'not set'}
        </span>
      </div>
      {canWrite ? (
        <div style={row}>
          {!released && !closed ? (
            <form action={lockBuildFunds} style={row}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="buildId" value={b.id} />
              <input type="hidden" name="key" value={randomUUID()} />
              <Field label="Lock" htmlFor={`lock-${b.id}`}>
                <Input
                  id={`lock-${b.id}`}
                  name="amount"
                  inputMode="decimal"
                  required
                  autoComplete="off"
                />
              </Field>
              <SubmitButton variant="secondary" iconLeft="lock" pendingLabel="Locking…">
                Lock funds
              </SubmitButton>
            </form>
          ) : null}
          {closed && !released && b.remainingMinor !== '0' ? (
            <form action={releaseBuildFunds}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="buildId" value={b.id} />
              <ConfirmSubmit
                question={`Return ${formatMoney(b.remainingMinor, currency)} to the balance?`}
                confirmLabel="Yes, release"
                iconLeft="refresh-cw"
              >
                Release the rest
              </ConfirmSubmit>
            </form>
          ) : null}
          <form action={saveBuildReward} style={row}>
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="buildId" value={b.id} />
            <input type="hidden" name="currency" value={b.rewardsCurrency ?? currency} />
            <Field
              label="Reward per accepted bug"
              htmlFor={`reward-${b.id}`}
              hint="Blank clears it."
            >
              <Input
                id={`reward-${b.id}`}
                name="reward"
                inputMode="decimal"
                defaultValue={reward}
                autoComplete="off"
              />
            </Field>
            <SubmitButton variant="secondary" pendingLabel="Saving…">
              Save reward
            </SubmitButton>
          </form>
        </div>
      ) : null}
    </li>
  )
}

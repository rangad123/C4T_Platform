import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList, type DescriptionItem } from '@/components/admin/DescriptionList'
import { RoleBadge, StatusBadge } from '@/components/admin/StatusBadge'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { formatDate, formatMoney, personName, titleCase } from '@/lib/admin/format'
import { hasPermission, requirePermission } from '@/lib/auth/session'
import { saveTransactionDetails, saveTransactionStatus, savePayoutDetails } from './actions'

/**
 * `/app/admin/transactions/[id]` — one ledger entry.
 *
 * §2.2 "Transactions": a payment or billing RECORD tied to a project, a
 * Customer or a Tester. §5 excludes gateway integration, so this page never
 * moves money — the status control records a decision someone made in a bank
 * or an accounting package, and the copy says so, because an admin who marks a
 * payout "paid" must not walk away believing the tester has been paid.
 *
 * Amount, currency, type and the linked records are read-only: the API's patch
 * schema accepts only status, description, externalRef and settledAt. A wrong
 * amount is corrected by recording an ADJUSTMENT against it, not by editing
 * history.
 */

const BASE = '/app/admin/transactions'

/**
 * Mirrors TransactionStatus. Kept here rather than imported from `./actions`
 * because every export of a `'use server'` module must be an async function —
 * exporting this array from there would unregister both actions.
 */
const STATUS_OPTIONS = ['PENDING', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED'].map((status) => ({
  value: status,
  label: titleCase(status),
}))

const PAYMENT_METHOD_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: 'IND_BANK_ACCOUNT', label: 'Indian bank account' },
  { value: 'NON_IND_BANK_ACCOUNT', label: 'International bank account' },
  { value: 'PAYPAL', label: 'PayPal' },
  { value: 'PAYTM', label: 'Paytm' },
]

interface TransactionDetail {
  id: string
  reference: string
  type: string
  status: string
  /** Minor units. A BigInt column, serialised as a string — never parse it as a float. */
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
  createdAt: string
  organisation: { id: string; name: string } | null
  project: { id: string; reference: string; title: string } | null
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
    email: string
    role: string
  } | null
  recordedBy: { id: string; firstName: string | null; lastName: string | null } | null
}

const recordLink = {
  color: 'var(--text-brand)',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
}

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requirePermission('transaction.read')
  const canWrite = hasPermission(user, 'transaction.write')

  const { id } = await params

  let tx: TransactionDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    tx = await serverFetch<TransactionDetail>(`transactions/${id}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    if (err instanceof ApiError && err.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError || !tx) {
    return (
      <DetailShell
        crumbs={[{ label: 'Transactions', href: BASE }, { label: 'Unavailable' }]}
        eyebrow="Operations"
        title="Transaction"
      >
        <EmptyState
          icon={loadError === 'forbidden' ? 'lock' : 'alert-triangle'}
          title={
            loadError === 'forbidden'
              ? "You don't have access to this transaction"
              : "Couldn't load this transaction"
          }
          description={
            loadError === 'forbidden'
              ? 'Ask an administrator to grant you the transaction.read permission.'
              : 'The transactions service is unreachable. Refresh in a moment.'
          }
          action={
            <Button href={BASE} variant="secondary" iconLeft="arrow-left">
              Back to transactions
            </Button>
          }
        />
      </DetailShell>
    )
  }

  /** `personName` returns an em dash for a missing person; null is what the
   *  DescriptionList and the subtitle both want instead. */
  const recordedByName = tx.recordedBy ? personName(tx.recordedBy) : null

  const entryItems: readonly DescriptionItem[] = [
    { label: 'Occurred on', value: formatDate(tx.occurredAt) },
    {
      label: 'Settled on',
      value: tx.settledAt ? formatDate(tx.settledAt) : null,
    },
    { label: 'External reference', value: tx.externalRef },
    { label: 'Recorded on', value: formatDate(tx.createdAt) },
    { label: 'Description', value: tx.description, wide: true },
  ]

  const linkItems: readonly DescriptionItem[] = [
    {
      label: 'Organisation',
      value: tx.organisation ? (
        <Link href={`/app/admin/organisations/${tx.organisation.id}`} style={recordLink}>
          {tx.organisation.name}
        </Link>
      ) : null,
    },
    {
      label: 'Project',
      value: tx.project ? (
        <Link href={`/app/admin/projects/${tx.project.id}`} style={recordLink}>
          {tx.project.reference} · {tx.project.title}
        </Link>
      ) : null,
    },
    {
      label: 'Counterparty',
      value: tx.counterparty ? (
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
          }}
        >
          <Link href={`/app/admin/users/${tx.counterparty.id}`} style={recordLink}>
            {personName(tx.counterparty)}
          </Link>
          <RoleBadge role={tx.counterparty.role} />
        </span>
      ) : null,
    },
    {
      label: 'Recorded by',
      value: tx.recordedBy ? (
        <Link href={`/app/admin/users/${tx.recordedBy.id}`} style={recordLink}>
          {recordedByName}
        </Link>
      ) : null,
    },
    {
      label: 'Bank details',
      value: tx.paymentAccount
        ? [
            titleCase(tx.paymentAccount.paymentType),
            tx.paymentAccount.bankName,
            tx.paymentAccount.accountNumberLast4 ? `•••• ${tx.paymentAccount.accountNumberLast4}` : null,
            tx.paymentAccount.paypalEmailMasked,
            tx.paymentAccount.paytmNumberLast4 ? `•••• ${tx.paymentAccount.paytmNumberLast4}` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : null,
    },
    { label: 'Build / contest reference', value: tx.buildOrContestRef },
  ]

  return (
    <DetailShell
      crumbs={[{ label: 'Transactions', href: BASE }, { label: tx.reference }]}
      eyebrow="Operations"
      title={tx.reference}
      subtitle={
        recordedByName
          ? `${titleCase(tx.type)} · recorded by ${recordedByName} on ${formatDate(tx.createdAt)}`
          : `${titleCase(tx.type)} · recorded ${formatDate(tx.createdAt)}`
      }
      badges={
        <>
          <StatusBadge status={tx.status} />
          <Badge tone="neutral" uppercase={false}>
            {titleCase(tx.type)}
          </Badge>
        </>
      }
      aside={
        <>
          <Panel
            title="Status"
            description="Records a decision taken elsewhere. Changing it moves no money."
          >
            {canWrite ? (
              <form
                action={saveTransactionStatus}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
              >
                <input type="hidden" name="id" value={tx.id} />
                <Field label="Status" htmlFor="status">
                  <Select
                    id="status"
                    name="status"
                    defaultValue={tx.status}
                    options={STATUS_OPTIONS}
                  />
                </Field>
                <Field
                  label="Settlement date"
                  htmlFor="settledAt"
                  hint="Leave empty to keep the stored date. Marking a row paid sets it to now."
                >
                  <Input id="settledAt" name="settledAt" type="date" />
                </Field>
                <Checkbox
                  name="clearSettledAt"
                  label="Clear the settlement date"
                  description="Takes precedence over the date above. Use it when a settlement is reversed."
                />
                <Button type="submit" variant="primary" fullWidth>
                  Save status
                </Button>
              </form>
            ) : (
              <p
                style={{
                  margin: 0,
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                This entry is {titleCase(tx.status).toLowerCase()}. Ask an administrator for the
                transaction.write permission to change it.
              </p>
            )}
          </Panel>

          <Panel title="Settlement happens outside the platform">
            <p
              style={{
                margin: 0,
                color: 'var(--text-secondary)',
                fontSize: 'var(--type-body-sm-size)',
                lineHeight: 1.55,
              }}
            >
              Payment gateway integration is out of scope, so this row is bookkeeping. The money
              still moves through your bank or your accounting package, and the counterparty is
              notified whenever the status changes here.
            </p>
          </Panel>
        </>
      }
    >
      <Panel title="Ledger entry">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <span
              className="c4t-display-md"
              style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatMoney(tx.amountMinor, tx.currency)}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--type-body-sm-size)',
                color: 'var(--text-muted)',
              }}
            >
              {tx.amountMinor} minor units · {tx.currency}
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-6)',
              paddingTop: 'var(--space-5)',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                Paid
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
                {formatMoney(tx.paidAmountMinor, tx.currency)}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                Outstanding
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
                {formatMoney(tx.outstandingMinor, tx.currency)}
              </span>
            </div>
            {tx.tdsAmountMinor ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                  TDS
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
                  {formatMoney(tx.tdsAmountMinor, tx.currency)}
                </span>
              </div>
            ) : null}
            {tx.paymentMethod ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                  Payment method
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{titleCase(tx.paymentMethod)}</span>
              </div>
            ) : null}
          </div>

          <div
            style={{
              paddingTop: 'var(--space-6)',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <DescriptionList items={entryItems} />
          </div>
        </div>
      </Panel>

      <Panel
        title="Linked records"
        description="Who the entry belongs to. Amount, currency and type are fixed once recorded."
      >
        <DescriptionList items={linkItems} />
      </Panel>

      {canWrite ? (
        <Panel
          title="Reconciliation"
          description="The two fields that let someone match this row to an invoice or a bank line."
        >
          <form
            action={saveTransactionDetails}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="id" value={tx.id} />
            <Field
              label="Description"
              htmlFor="description"
              hint="What this covers. Visible to the counterparty in their portal."
            >
              <Textarea
                id="description"
                name="description"
                rows={4}
                maxLength={1000}
                defaultValue={tx.description ?? ''}
                placeholder="Sprint 4 regression pass, 12 testers"
              />
            </Field>
            <Field
              label="External reference"
              htmlFor="externalRef"
              hint="The invoice number, UTR or payout batch id this row mirrors."
            >
              <Input
                id="externalRef"
                name="externalRef"
                maxLength={120}
                defaultValue={tx.externalRef ?? ''}
                placeholder="INV-2026-0142"
              />
            </Field>
            <div>
              <Button type="submit" variant="secondary">
                Save reconciliation details
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}

      {canWrite ? (
        <Panel
          title="Payout details"
          description="§21-27 — drives which category (Indian / International / Pending) this row appears under, and what a customer or tester's outstanding balance shows."
        >
          <form
            action={savePayoutDetails}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="id" value={tx.id} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
              <Field label="Payment method" htmlFor="paymentMethod">
                <Select
                  id="paymentMethod"
                  name="paymentMethod"
                  defaultValue={tx.paymentMethod ?? ''}
                  options={PAYMENT_METHOD_OPTIONS}
                />
              </Field>
              <Field
                label="Paid amount"
                htmlFor="paidAmount"
                hint="Major units, e.g. 1500.50. Blank leaves it unchanged."
              >
                <Input id="paidAmount" name="paidAmount" inputMode="decimal" placeholder="0.00" />
              </Field>
              <Field
                label="TDS amount"
                htmlFor="tdsAmount"
                hint="Major units. Blank leaves it unchanged."
              >
                <Input id="tdsAmount" name="tdsAmount" inputMode="decimal" placeholder="0.00" />
              </Field>
              <Field
                label="Build / contest reference"
                htmlFor="buildOrContestRef"
                hint="Free text — the build or contest this payout is for, if not already covered by the linked project."
              >
                <Input
                  id="buildOrContestRef"
                  name="buildOrContestRef"
                  maxLength={160}
                  defaultValue={tx.buildOrContestRef ?? ''}
                />
              </Field>
            </div>
            <div>
              <Button type="submit" variant="secondary">
                Save payout details
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}
    </DetailShell>
  )
}

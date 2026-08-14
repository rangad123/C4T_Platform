import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select, type SelectOption } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { serverFetch, serverFetchPage } from '@/lib/api/server'
import { ApiError, type ValidationDetail } from '@/lib/api/types'
import { personName, titleCase } from '@/lib/admin/format'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * `/app/admin/transactions/new` — record a ledger entry.
 *
 * §2.2 gives an Admin the ability to record payment and billing rows against a
 * project, a Customer or a Tester. §5 keeps payment gateway integration out of
 * scope, so this form writes a RECORD and nothing else: no card is charged, no
 * payout is sent. The page says that in as many words, because "record a
 * payout" and "pay someone" are one click apart and only one of them is true.
 *
 * MONEY. `amountMinor` is a BigInt column. The admin types major units (rupees
 * and paise); `toMinorUnits` converts by string surgery, never by
 * `amount * 100` — 19.99 * 100 is 1998.9999999999998 in IEEE 754, which would
 * round to ₹19.98 or ₹19.99 depending on which way the coercion fell, and a
 * ledger that is a paisa out is a ledger nobody trusts.
 *
 * FORM STATE. There is no client JavaScript here. A rejected submit redirects
 * back with the values in the query string, so the admin gets an error message
 * and keeps everything they typed.
 */

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

/** Mirrors the API's own coherence rules, so the message arrives without a round trip. */
const ORGANISATION_REQUIRED: readonly string[] = [
  'CUSTOMER_INVOICE',
  'CUSTOMER_PAYMENT',
  'REFUND',
]
const COUNTERPARTY_REQUIRED: readonly string[] = ['TESTER_EARNING', 'TESTER_PAYOUT']

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP'] as const

const TYPE_OPTIONS: readonly SelectOption[] = TYPES.map((type) => ({
  value: type,
  label: titleCase(type),
}))
const STATUS_OPTIONS: readonly SelectOption[] = STATUSES.map((status) => ({
  value: status,
  label: titleCase(status),
}))

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** The keys the form echoes back through the URL when a submit is rejected. */
const ECHO_KEYS = [
  'type',
  'status',
  'amount',
  'currency',
  'organisationId',
  'projectId',
  'counterpartyId',
  'description',
  'externalRef',
  'occurredAt',
] as const

type EchoKey = (typeof ECHO_KEYS)[number]
type Echo = Partial<Record<EchoKey, string>>

/**
 * Major units → an integer string of minor units.
 *
 * Accepts `1500`, `1500.5`, `1500.50` and a pasted `1,500.50`. Returns null for
 * anything else, including zero and negatives — the API requires a positive
 * amount, and a negative correction is recorded as an ADJUSTMENT or a REFUND
 * rather than as a negative row.
 *
 * The result is only ever a digit string, which matters: the API coerces it with
 * `BigInt()`, and `BigInt('19.99')` throws rather than validating.
 */
function toMinorUnits(input: string): string | null {
  const cleaned = input.replace(/[\s,]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null

  const [whole, fraction = ''] = cleaned.split('.')
  const minor = `${whole}${`${fraction}00`.slice(0, 2)}`.replace(/^0+(?=\d)/, '')

  if (/^0+$/.test(minor)) return null
  // 15 digits of paise is ₹10 trillion. Beyond that the column would overflow
  // and the insert would fail as a 500, so it is rejected here as a value.
  if (minor.length > 15) return null
  return minor
}

/** The first field-level message from a 422, which is far more use than "Validation failed". */
function firstDetail(details: unknown): string | null {
  if (!Array.isArray(details)) return null
  const first = details[0] as Partial<ValidationDetail> | undefined
  if (!first?.message) return null
  return first.field ? `${first.field}: ${first.message}` : first.message
}

function backToForm(message: string, echo: Echo): string {
  const sp = new URLSearchParams()
  for (const key of ECHO_KEYS) {
    const value = echo[key]
    if (value) sp.set(key, value)
  }
  sp.set('error', message.slice(0, 240))
  return `${BASE}/new?${sp.toString()}`
}

async function recordTransaction(formData: FormData): Promise<void> {
  'use server'
  await requirePermission('transaction.write')

  const echo: Echo = {}
  for (const key of ECHO_KEYS) {
    const value = formTrimmed(formData, key)
    if (value) echo[key] = value
  }

  const type = echo.type ?? ''
  const status = echo.status ?? 'PENDING'
  const currency = (echo.currency ?? 'INR').toUpperCase()
  const occurredAt = echo.occurredAt ?? ''
  const amountMinor = toMinorUnits(echo.amount ?? '')

  if (!(TYPES as readonly string[]).includes(type)) {
    redirect(backToForm('Choose a transaction type.', echo))
  }
  if (!(STATUSES as readonly string[]).includes(status)) {
    redirect(backToForm('Choose a status.', echo))
  }
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    redirect(backToForm('Choose a currency.', echo))
  }
  if (!amountMinor) {
    redirect(
      backToForm(
        'Enter an amount greater than zero, in major units with at most two decimal places.',
        echo,
      ),
    )
  }
  if (occurredAt && !DATE_ONLY.test(occurredAt)) {
    redirect(backToForm('Enter the date it occurred as a calendar date.', echo))
  }
  const label = titleCase(type).toLowerCase()
  if (ORGANISATION_REQUIRED.includes(type) && !echo.organisationId) {
    redirect(backToForm(`Pick an organisation — a ${label} needs one.`, echo))
  }
  if (COUNTERPARTY_REQUIRED.includes(type) && !echo.counterpartyId) {
    redirect(backToForm(`Pick a tester — a ${label} needs one.`, echo))
  }

  let createdId: string | null = null
  let failure: string | null = null

  try {
    const created = await serverFetch<{ id: string }>('transactions', {
      method: 'POST',
      body: {
        type,
        status,
        amountMinor,
        currency,
        ...(echo.organisationId ? { organisationId: echo.organisationId } : {}),
        ...(echo.projectId ? { projectId: echo.projectId } : {}),
        ...(echo.counterpartyId ? { counterpartyId: echo.counterpartyId } : {}),
        ...(echo.description ? { description: echo.description.slice(0, 1000) } : {}),
        ...(echo.externalRef ? { externalRef: echo.externalRef.slice(0, 120) } : {}),
        ...(occurredAt ? { occurredAt } : {}),
      },
    })
    createdId = created.id
  } catch (err) {
    if (err instanceof ApiError) {
      failure = firstDetail(err.details) ?? err.message
    } else {
      failure = 'The transactions service is unreachable. Try again in a moment.'
    }
  }

  if (!createdId) {
    redirect(backToForm(failure ?? 'The entry was not recorded. Try again.', echo))
  }

  revalidatePath(BASE)
  redirect(`${BASE}/${createdId}`)
}

interface OrganisationRow {
  id: string
  name: string
}
interface ProjectRow {
  id: string
  reference: string
  title: string
  organisation: { id: string; name: string } | null
}
interface TesterRow {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * A tolerant list read for a picker.
 *
 * A sub-admin can hold `transaction.write` without `organisation.read` or
 * `user.read`. That must not blow up the page — the picker renders empty with a
 * line saying so, and the fields that do not need it still work.
 */
async function loadRows<T>(
  path: string,
  query: Record<string, string | number>,
): Promise<{ rows: T[]; failed: boolean }> {
  try {
    const { data } = await serverFetchPage<T>(path, { query })
    return { rows: data, failed: false }
  } catch {
    return { rows: [], failed: true }
  }
}

/** 100 is the API's maximum page size, so a picker shows at most that many. */
const PICKER_LIMIT = 100

/**
 * The hint under a picker, which has three jobs: name the missing permission
 * when the list could not be read, say so when nothing exists yet, and admit
 * when the list is truncated rather than letting an admin conclude a record is
 * missing.
 */
function pickerHint(args: {
  failed: boolean
  count: number
  permission: string
  empty: string
  hint: string
}): string {
  if (args.failed) {
    return `This list could not be loaded. Ask an administrator for the ${args.permission} permission.`
  }
  if (args.count === 0) return args.empty
  if (args.count === PICKER_LIMIT) return `${args.hint} Showing the first ${PICKER_LIMIT}.`
  return args.hint
}

export default async function NewTransactionPage({
  searchParams,
}: {
  searchParams: Promise<Partial<Record<EchoKey | 'error', string>>>
}) {
  await requirePermission('transaction.write')

  const params = await searchParams
  const [organisations, projects, testers] = await Promise.all([
    loadRows<OrganisationRow>('organisations', {
      limit: PICKER_LIMIT,
      sort: 'name',
      order: 'asc',
    }),
    loadRows<ProjectRow>('projects', { limit: PICKER_LIMIT, sort: 'title', order: 'asc' }),
    loadRows<TesterRow>('users', {
      limit: PICKER_LIMIT,
      role: 'TESTER',
      status: 'ACTIVE',
      sort: 'email',
      order: 'asc',
    }),
  ])

  const organisationOptions: SelectOption[] = organisations.rows.map((org) => ({
    value: org.id,
    label: org.name,
  }))
  const projectOptions: SelectOption[] = projects.rows.map((project) => ({
    value: project.id,
    label: project.organisation
      ? `${project.reference} · ${project.title} — ${project.organisation.name}`
      : `${project.reference} · ${project.title}`,
  }))
  const testerOptions: SelectOption[] = testers.rows.map((tester) => ({
    value: tester.id,
    label: `${personName(tester)} — ${tester.email}`,
  }))

  const today = new Date().toISOString().slice(0, 10)
  const error = params.error?.slice(0, 240)

  return (
    <DetailShell
      crumbs={[{ label: 'Transactions', href: BASE }, { label: 'New entry' }]}
      eyebrow="Operations"
      title="Record a transaction"
      subtitle="An invoice, a payment, a tester's earning or a payout. One row per event."
      aside={
        <>
          <Panel title="This records a payment, it does not make one">
            <p
              style={{
                margin: 0,
                color: 'var(--text-secondary)',
                fontSize: 'var(--type-body-sm-size)',
                lineHeight: 1.55,
              }}
            >
              Payment gateway integration is out of scope, so saving this form moves no money.
              Sending a payout, collecting an invoice and refunding a customer all still happen in
              your bank or your accounting package. This is the record of it.
            </p>
          </Panel>

          <Panel title="What happens on save">
            <ul
              style={{
                margin: 0,
                paddingLeft: 'var(--space-6)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                color: 'var(--text-secondary)',
                fontSize: 'var(--type-body-sm-size)',
                lineHeight: 1.55,
              }}
            >
              <li>The entry gets a reference and appears in the ledger.</li>
              <li>The counterparty, if there is one, is notified that a transaction was recorded.</li>
              <li>
                A row is written to the audit log against your account, and the amount, currency and
                type can no longer be edited.
              </li>
            </ul>
          </Panel>
        </>
      }
    >
      <Panel
        title="Entry"
        description="Amounts are entered in major units and stored as an integer number of minor units."
      >
        <form
          action={recordTransaction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
        >
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
                lineHeight: 1.5,
              }}
            >
              <Icon name="alert-triangle" size={18} />
              <span>{error}</span>
            </p>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 'var(--space-6)',
            }}
          >
            <Field label="Type" htmlFor="type" required hint="What kind of event this row records.">
              <Select
                id="type"
                name="type"
                required
                defaultValue={params.type ?? ''}
                placeholder="Choose a type"
                options={TYPE_OPTIONS}
              />
            </Field>

            <Field
              label="Status"
              htmlFor="status"
              hint="Paid also stamps the settlement date with today."
            >
              <Select
                id="status"
                name="status"
                defaultValue={params.status ?? 'PENDING'}
                options={STATUS_OPTIONS}
              />
            </Field>

            <Field
              label="Amount"
              htmlFor="amount"
              required
              hint="Major units, up to two decimal places — 1500.50 is stored as 150050."
            >
              <Input
                id="amount"
                name="amount"
                required
                inputMode="decimal"
                autoComplete="off"
                placeholder="1500.00"
                defaultValue={params.amount ?? ''}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              />
            </Field>

            <Field label="Currency" htmlFor="currency">
              <Select
                id="currency"
                name="currency"
                defaultValue={params.currency ?? 'INR'}
                options={CURRENCIES}
              />
            </Field>

            <Field
              label="Occurred on"
              htmlFor="occurredAt"
              hint="The date of the event, not the date you entered it."
            >
              <Input
                id="occurredAt"
                name="occurredAt"
                type="date"
                defaultValue={params.occurredAt ?? today}
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
                autoComplete="off"
                placeholder="INV-2026-0142"
                defaultValue={params.externalRef ?? ''}
              />
            </Field>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-6)',
              paddingTop: 'var(--space-6)',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <Field
              label="Organisation"
              htmlFor="organisationId"
              hint={pickerHint({
                failed: organisations.failed,
                count: organisationOptions.length,
                permission: 'organisation.read',
                empty: 'No organisations exist yet, so only tester-side entries can be recorded.',
                hint: 'Required for a customer invoice, a customer payment and a refund.',
              })}
            >
              <Select
                id="organisationId"
                name="organisationId"
                defaultValue={params.organisationId ?? ''}
                placeholder="No organisation"
                options={organisationOptions}
              />
            </Field>

            <Field
              label="Project"
              htmlFor="projectId"
              hint={pickerHint({
                failed: projects.failed,
                count: projectOptions.length,
                permission: 'project.read',
                empty: 'No projects exist yet.',
                hint: 'Optional. Attach the entry to the project it was billed against.',
              })}
            >
              <Select
                id="projectId"
                name="projectId"
                defaultValue={params.projectId ?? ''}
                placeholder="No project"
                options={projectOptions}
              />
            </Field>

            <Field
              label="Counterparty"
              htmlFor="counterpartyId"
              hint={pickerHint({
                failed: testers.failed,
                count: testerOptions.length,
                permission: 'tester.read',
                empty: 'No active testers exist yet.',
                hint: 'Active testers only. Required for a tester earning and a tester payout.',
              })}
            >
              <Select
                id="counterpartyId"
                name="counterpartyId"
                defaultValue={params.counterpartyId ?? ''}
                placeholder="No counterparty"
                options={testerOptions}
              />
            </Field>

            <Field
              label="Description"
              htmlFor="description"
              hint="What the amount covers. The counterparty sees this in their portal."
            >
              <Textarea
                id="description"
                name="description"
                rows={4}
                maxLength={1000}
                defaultValue={params.description ?? ''}
                placeholder="Sprint 4 regression pass, 12 testers"
              />
            </Field>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            <Button type="submit" variant="primary">
              Record the transaction
            </Button>
            <Button href={BASE} variant="secondary">
              Cancel
            </Button>
          </div>
        </form>
      </Panel>
    </DetailShell>
  )
}

'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requirePermission } from '@/lib/auth/session'
import { formString, formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for a single ledger entry.
 *
 * EVERY export in this module is an async function. A `'use server'` file whose
 * exports include a type, a const or a class silently unregisters every action
 * in it, and the form then fails at runtime with an opaque
 * UnrecognizedActionError — so the status list below stays private, and the
 * page keeps its own copy for the Select. Two five-item arrays beats a runtime
 * failure that looks like a framework bug.
 *
 * The API is the enforcement point (it holds the audit log and the
 * `transaction.write` gate), but a Server Action is a public POST endpoint, so
 * the permission is re-checked here rather than trusted from the render that
 * produced the form.
 *
 * PATCH transactions/:id accepts status, description, externalRef, settledAt,
 * plus (§21-27) paymentMethod, paymentAccountId, paidAmountMinor,
 * tdsAmountMinor, buildOrContestRef. Amount, currency, type and the linked
 * records are immutable by design: correcting a wrong amount means recording
 * an ADJUSTMENT against it, which is what keeps the ledger auditable.
 */

const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED'] as const
const PAYMENT_METHODS = ['IND_BANK_ACCOUNT', 'NON_IND_BANK_ACCOUNT', 'PAYPAL', 'PAYTM'] as const

/**
 * Major units → minor units, by string surgery rather than `amount * 100` —
 * same reasoning and same shape as `toMinorUnits` in `new/page.tsx` (IEEE 754
 * makes `19.99 * 100` come out `1998.9999999999998`). Null for empty/zero,
 * which the caller below treats as "no change" for these optional fields.
 */
function toMinorUnitsOrNull(input: string): string | null {
  const cleaned = input.replace(/[\s,]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, fraction = ''] = cleaned.split('.')
  const minor = `${whole}${`${fraction}00`.slice(0, 2)}`.replace(/^0+(?=\d)/, '')
  if (/^0+$/.test(minor) || minor.length > 15) return null
  return minor
}

/** A `<input type="date">` value. Sent as-is, so it lands on UTC midnight. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function isStatus(value: string): boolean {
  return (STATUSES as readonly string[]).includes(value)
}

function revalidate(id: string): void {
  revalidatePath('/app/admin/transactions')
  revalidatePath(`/app/admin/transactions/${id}`)
}

/**
 * Status, and the settlement date that goes with it.
 *
 * `settledAt` is deliberately not prefilled in the form: an empty date field
 * means "leave it alone", so saving a status change never truncates a stored
 * timestamp to midnight. Clearing it is an explicit checkbox, and it wins over
 * a date typed in the same submit.
 *
 * The API sets `settledAt` to now on its own when the status becomes PAID and
 * no date was supplied, so the common case needs no date at all.
 */
export async function saveTransactionStatus(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')

  const id = formTrimmed(formData, 'id')
  const status = formTrimmed(formData, 'status')
  if (!id || !isStatus(status)) return

  const clear = formString(formData, 'clearSettledAt') === 'on'
  const settledAt = formTrimmed(formData, 'settledAt')

  const body: Record<string, unknown> = { status }
  if (clear) body.settledAt = null
  else if (DATE_ONLY.test(settledAt)) body.settledAt = settledAt

  await serverFetch<{ id: string }>(`transactions/${id}`, { method: 'PATCH', body })
  revalidate(id)
}

/**
 * The description and the external reference — the two fields that exist so a
 * row can be matched back to an invoice or a bank statement.
 *
 * Both are sent as `''` when empty, never `null`: the patch schema types them
 * as optional strings, and a null would come back as a 422 rather than
 * clearing the field.
 */
export async function saveTransactionDetails(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  await serverFetch<{ id: string }>(`transactions/${id}`, {
    method: 'PATCH',
    body: {
      description: formTrimmed(formData, 'description').slice(0, 1000),
      externalRef: formTrimmed(formData, 'externalRef').slice(0, 120),
    },
  })

  revalidate(id)
}

/**
 * §21-27's payout fields. Unlike `saveTransactionDetails`, the two amount
 * fields are OMITTED rather than sent as `''` when blank — the API types them
 * as `z.coerce.bigint()`, which throws on an empty string instead of treating
 * it as "clear this field" the way the string fields above do. Leaving a
 * money field blank here means "no change", not "set to zero".
 */
export async function savePayoutDetails(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  const paymentMethod = formTrimmed(formData, 'paymentMethod')
  const paidAmountMinor = toMinorUnitsOrNull(formTrimmed(formData, 'paidAmount'))
  const tdsAmountMinor = toMinorUnitsOrNull(formTrimmed(formData, 'tdsAmount'))
  const buildOrContestRef = formTrimmed(formData, 'buildOrContestRef')

  await serverFetch<{ id: string }>(`transactions/${id}`, {
    method: 'PATCH',
    body: {
      ...((PAYMENT_METHODS as readonly string[]).includes(paymentMethod)
        ? { paymentMethod }
        : {}),
      ...(paidAmountMinor ? { paidAmountMinor } : {}),
      ...(tdsAmountMinor ? { tdsAmountMinor } : {}),
      buildOrContestRef: buildOrContestRef.slice(0, 160),
    },
  })

  revalidate(id)
}

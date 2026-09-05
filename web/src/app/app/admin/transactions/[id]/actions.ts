'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ApiError } from '@/lib/api/types'
import { actionFetch } from '@/lib/api/action-fetch'
import { requirePermission } from '@/lib/auth/session'
import { formString, formTrimmed } from '@/lib/form-data'
import { PAYMENT_METHODS, TRANSACTION_STATUSES } from '@/lib/domain/enums'

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

const STATUSES = TRANSACTION_STATUSES

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

/**
 * Module-private: a `'use server'` file may only export async functions, so a
 * shared helper has to stay unexported or every action in the file silently
 * stops being registered.
 */
const BASE = '/app/admin/transactions'

function saveFailure(error: unknown): string {
  const code = error instanceof ApiError ? error.status : 0
  if (code === 403) return 'tx-forbidden'
  if (code === 404) return 'tx-missing'
  if (code === 409) return 'tx-conflict'
  if (code === 400 || code === 422) return 'tx-invalid'
  return 'tx-failed'
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

  let notice = 'tx-status-saved'
  try {
    await actionFetch<{ id: string }>(`transactions/${id}`, { method: 'PATCH', body })
  } catch (error) {
    notice = saveFailure(error)
  }

  revalidate(id)
  redirect(`${BASE}/${id}?notice=${notice}`)
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

  let notice = 'tx-details-saved'
  try {
    await actionFetch<{ id: string }>(`transactions/${id}`, {
      method: 'PATCH',
      body: {
        description: formTrimmed(formData, 'description').slice(0, 1000),
        externalRef: formTrimmed(formData, 'externalRef').slice(0, 120),
      },
    })
  } catch (error) {
    notice = saveFailure(error)
  }

  revalidate(id)
  redirect(`${BASE}/${id}?notice=${notice}`)
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

  let notice = 'tx-payout-saved'
  try {
    await actionFetch<{ id: string }>(`transactions/${id}`, {
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
  } catch (error) {
    notice = saveFailure(error)
  }

  revalidate(id)
  redirect(`${BASE}/${id}?notice=${notice}`)
}

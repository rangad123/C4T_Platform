'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { formTrimmed } from '@/lib/form-data'

const DASHBOARD = '/app/tester'

/**
 * Ask to be paid the available balance.
 *
 * The amount is deliberately NOT sent. The API pays out whatever is available
 * at the moment it runs, so a balance that changed between the page rendering
 * and the button being pressed settles correctly instead of failing on a
 * stale number the browser was holding.
 *
 * Every failure the API can raise here is a rule the tester can act on — no
 * payment details, below the minimum, one already in flight — so each maps to
 * its own message rather than a generic "something went wrong". The API's own
 * error text is never forwarded.
 */
export async function requestPayoutAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const note = formTrimmed(formData, 'note')

  try {
    await actionFetch('transactions/payouts/request', {
      method: 'POST',
      body: note ? { note } : {},
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    const message = error instanceof ApiError ? error.message : ''
    // 400 covers every rule above; the page re-reads the real state on the
    // redirect, so the notice only has to say which rule was hit. A 403 for
    // an unverified email gets its own code — "try again in a moment" (the
    // generic `payout-failed` message) would be actively wrong here, since
    // retrying can never succeed until the address is verified.
    const code =
      status === 400
        ? 'payout-rejected'
        : status === 403 && message.includes('Verify your email')
          ? 'email-not-verified'
          : 'payout-failed'
    redirect(`${DASHBOARD}?notice=${code}`)
  }

  revalidatePath(DASHBOARD)
  redirect(`${DASHBOARD}?notice=payout-requested`)
}

/**
 * Withdraw an open payout request.
 *
 * Without this a request nobody wants paid would reserve the balance and block
 * a fresh one indefinitely. Only the tester's own open request can be
 * cancelled — the API answers 404 for anyone else's, or one already paid, and
 * that is reported as the same "cancelled" outcome because the state the tester
 * wanted (no open request) is already true.
 */
export async function cancelPayoutRequestAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  let code = 'payout-cancelled'
  if (!id) code = 'payout-rejected'
  else {
    try {
      await actionFetch(`transactions/payouts/requests/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      if (status !== 404) code = 'payout-failed'
    }
  }

  revalidatePath(DASHBOARD)
  redirect(`${DASHBOARD}?notice=${code}`)
}

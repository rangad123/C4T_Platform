'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
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
    await serverFetch('transactions/payouts/request', {
      method: 'POST',
      body: note ? { note } : {},
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    // 400 covers every rule above; the page re-reads the real state on the
    // redirect, so the notice only has to say which rule was hit.
    redirect(`${DASHBOARD}?notice=${status === 400 ? 'payout-rejected' : 'payout-failed'}`)
  }

  revalidatePath(DASHBOARD)
  redirect(`${DASHBOARD}?notice=payout-requested`)
}

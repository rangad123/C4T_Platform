/**
 * Recording a tester's bank transfer.
 *
 * A transfer is only ever recorded against the tester's open payout request,
 * and recording it settles that request (the API closes it). Every page that
 * offers "Record bank transfer" builds its link here, so they all fill the
 * transaction form the same way.
 */

/** `150050` → `1500.50`, by string surgery — the transaction form takes major units. */
export function toMajor(minor: string): string {
  const negative = minor.startsWith('-')
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/** The transaction form, filled in with the tester, the request and the amount they asked for. */
export function recordTransferHref(input: {
  testerId: string
  request: { id: string; amountMinor: string }
  currency: string
  paymentType?: string | null
}): string {
  const sp = new URLSearchParams({
    type: 'TESTER_PAYOUT',
    counterpartyId: input.testerId,
    amount: toMajor(input.request.amountMinor),
    currency: input.currency,
    payoutRequestId: input.request.id,
  })
  if (input.paymentType) sp.set('paymentMethod', input.paymentType)
  return `/app/admin/transactions/new?${sp.toString()}`
}

/**
 * Recording a tester's bank transfer.
 *
 * When the tester has an open payout request, the transfer is recorded against
 * it and settles it (the API closes it): Already requested moves to Paid out.
 * When they have not asked, the transfer goes straight from Available to
 * withdraw to Paid out. Every page that offers "Record bank transfer" builds
 * its link here, so they all fill the transaction form the same way.
 */

/** `150050` → `1500.50`, by string surgery — the transaction form takes major units. */
export function toMajor(minor: string): string {
  const negative = minor.startsWith('-')
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/**
 * The transaction form, filled in with the tester and the amount: what they
 * asked for when there is a request, otherwise what is available to withdraw.
 */
export function recordTransferHref(input: {
  testerId: string
  amountMinor: string
  currency: string
  requestId?: string | null
  paymentType?: string | null
}): string {
  const sp = new URLSearchParams({
    type: 'TESTER_PAYOUT',
    counterpartyId: input.testerId,
    amount: toMajor(input.amountMinor),
    currency: input.currency,
  })
  if (input.requestId) sp.set('payoutRequestId', input.requestId)
  if (input.paymentType) sp.set('paymentMethod', input.paymentType)
  return `/app/admin/transactions/new?${sp.toString()}`
}

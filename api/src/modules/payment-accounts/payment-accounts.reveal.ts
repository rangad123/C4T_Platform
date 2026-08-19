import { prisma } from '../../lib/prisma.js'
import { decryptPaymentDetails, type PaymentDetailsPlain } from '../../lib/payment-encryption.js'
import { NotFoundError } from '../../lib/errors.js'

/**
 * The ONLY function in this module allowed to touch `secureDetails`.
 *
 * Deliberately its own file, imported by exactly one route handler
 * (`POST /:id/reveal` in `payment-accounts.routes.ts`) — every other read in
 * this module goes through `payment-accounts.routes.ts`'s masked `select`,
 * which never lists this column. Keeping the decrypting query physically
 * separate means a future edit to "just add a field to the list response"
 * cannot accidentally widen it to include ciphertext, let alone plaintext.
 */
export async function revealPaymentAccount(id: string): Promise<PaymentDetailsPlain> {
  const row = await prisma.paymentAccount.findUnique({
    where: { id },
    select: { id: true, userId: true, secureDetails: true },
  })
  if (!row) throw new NotFoundError('Payment account')

  return decryptPaymentDetails(Buffer.from(row.secureDetails), `${row.id}:${row.userId}`)
}

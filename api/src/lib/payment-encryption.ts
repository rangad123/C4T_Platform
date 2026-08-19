import crypto from 'node:crypto'
import { env } from '../config/env.js'

/**
 * Authenticated encryption for tester payout details (§14-16 of the bank-
 * details brief) — AES-256-GCM via `node:crypto`, no third-party dependency.
 *
 * ── Envelope layout
 *
 * One opaque `Buffer` per `PaymentAccount` row, laid out as:
 *
 *   [1 byte key version][12 byte IV][ciphertext][16 byte GCM auth tag]
 *
 * A single combined blob rather than one blob per field: the only consumer
 * that ever needs the plaintext is the admin "reveal" action, and that
 * reveals every field at once — five separate IV/tag pairs would buy nothing
 * and just be five more places to get the framing wrong. The version byte is
 * unused today (always `0`) but reserved so a future key rotation has
 * somewhere to record which key encrypted a given row, without a schema
 * change or a flag day where every row must be re-encrypted simultaneously.
 *
 * ── Key
 *
 * `PAYMENT_ENCRYPTION_KEY` — base64, decodes to exactly 32 bytes — validated
 * in `config/env.ts` the same way `JWT_PRIVATE_KEY` is: fail at boot, not on
 * the first request that needs it. The key never touches the database; it
 * lives only in the environment, same as every other secret this API holds.
 *
 * ── AAD
 *
 * The caller supplies additional authenticated data (AAD) — this module uses
 * `${paymentAccountId}:${userId}` — which GCM binds to the ciphertext without
 * encrypting it. Swapping one row's encrypted bytes onto another row's id (a
 * corrupted backup restore, a bad migration, a copy-paste in an admin tool)
 * fails tag verification instead of silently decrypting as someone else's
 * bank details.
 */

const KEY_VERSION = 0
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function loadKey(): Buffer {
  let key: Buffer
  try {
    key = Buffer.from(env.PAYMENT_ENCRYPTION_KEY, 'base64')
  } catch {
    throw new Error('PAYMENT_ENCRYPTION_KEY is not valid base64')
  }
  if (key.length !== 32) {
    throw new Error(
      `PAYMENT_ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM, got ${key.length}`,
    )
  }
  return key
}

const key: Buffer = loadKey()

export interface PaymentDetailsPlain {
  accountName?: string
  accountNumber?: string
  ifscCode?: string
  paypalEmail?: string
  paytmNumber?: string
}

export function encryptPaymentDetails(plain: PaymentDetailsPlain, aad: string): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))

  const plaintext = Buffer.from(JSON.stringify(plain), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  return Buffer.concat([Buffer.from([KEY_VERSION]), iv, ciphertext, authTag])
}

/**
 * Throws on a truncated envelope or a failed tag check — a caller must never
 * receive a silently-wrong plaintext from a tampered or corrupted blob.
 */
export function decryptPaymentDetails(envelope: Buffer, aad: string): PaymentDetailsPlain {
  if (envelope.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Payment details envelope is truncated')
  }

  const version = envelope[0]
  if (version !== KEY_VERSION) {
    throw new Error(`Unsupported payment details key version: ${version}`)
  }

  const iv = envelope.subarray(1, 1 + IV_LENGTH)
  const authTag = envelope.subarray(envelope.length - AUTH_TAG_LENGTH)
  const ciphertext = envelope.subarray(1 + IV_LENGTH, envelope.length - AUTH_TAG_LENGTH)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as PaymentDetailsPlain
}

/**
 * Masked projections, computed once here while the plaintext is in hand —
 * GCM ciphertext cannot be partially decrypted, so "last 4 digits" has no
 * cheaper source than the same moment the full value is available (write
 * time), never derived later from the stored envelope.
 */
export function maskPaymentDetails(plain: PaymentDetailsPlain): {
  accountNumberLast4: string | null
  paypalEmailMasked: string | null
  paytmNumberLast4: string | null
} {
  return {
    accountNumberLast4: plain.accountNumber ? plain.accountNumber.slice(-4) : null,
    paypalEmailMasked: plain.paypalEmail ? maskEmail(plain.paypalEmail) : null,
    paytmNumberLast4: plain.paytmNumber ? plain.paytmNumber.slice(-4) : null,
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return '***'
  const visible = local.slice(0, 2)
  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 1))}@${domain}`
}

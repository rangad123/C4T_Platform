import crypto from 'node:crypto'
import { env } from '../../config/env.js'

/**
 * Authenticated encryption for HrEmployee financial fields (PAN, bank
 * account number, account holder name) — the same AES-256-GCM envelope as
 * lib/payment-encryption.ts, duplicated rather than parameterised.
 *
 * WHY DUPLICATED, NOT SHARED. HRMS is a deliberately separate identity
 * domain from the testing platform (see the schema's HRMS section) — its own
 * key, `HRMS_ENCRYPTION_KEY`, never `PAYMENT_ENCRYPTION_KEY`. Forcing one
 * function to take a key parameter would mean touching the already-audited,
 * working payment-encryption.ts for a second, unrelated caller; ~40 lines of
 * proven crypto duplicated with a clear provenance comment is the safer
 * trade. If the envelope format ever needs to change, change both files —
 * they are independent by design, not two ends of an abstraction.
 *
 * ── Envelope layout (identical to payment-encryption.ts)
 *
 *   [1 byte key version][12 byte IV][ciphertext][16 byte GCM auth tag]
 *
 * ── AAD
 *
 * The caller supplies `${employeeId}`, which GCM binds to the ciphertext
 * without encrypting it — a corrupted backup restore or a copy-paste bug
 * that lands one row's encrypted bytes on another row's id fails tag
 * verification instead of silently decrypting as someone else's PAN.
 */

const KEY_VERSION = 0
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function loadKey(): Buffer {
  let key: Buffer
  try {
    key = Buffer.from(env.HRMS_ENCRYPTION_KEY, 'base64')
  } catch {
    throw new Error('HRMS_ENCRYPTION_KEY is not valid base64')
  }
  if (key.length !== 32) {
    throw new Error(
      `HRMS_ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM, got ${key.length}`,
    )
  }
  return key
}

const key: Buffer = loadKey()

export interface HrFinancialDetailsPlain {
  panNumber?: string
  accountNumber?: string
  accountName?: string
  ifscCode?: string
}

export function encryptHrFinancialDetails(plain: HrFinancialDetailsPlain, aad: string): Buffer {
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
export function decryptHrFinancialDetails(envelope: Buffer, aad: string): HrFinancialDetailsPlain {
  if (envelope.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('HR financial details envelope is truncated')
  }

  const version = envelope[0]
  if (version !== KEY_VERSION) {
    throw new Error(`Unsupported HR financial details key version: ${version}`)
  }

  const iv = envelope.subarray(1, 1 + IV_LENGTH)
  const authTag = envelope.subarray(envelope.length - AUTH_TAG_LENGTH)
  const ciphertext = envelope.subarray(1 + IV_LENGTH, envelope.length - AUTH_TAG_LENGTH)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as HrFinancialDetailsPlain
}

/** "ABCDE1234F" -> "ABC***34F" for a list view. Never used to reconstruct the real value. */
export function maskPan(panNumber: string | undefined): string | null {
  if (!panNumber || panNumber.length < 6) return null
  return `${panNumber.slice(0, 3)}***${panNumber.slice(-3)}`
}

/** "1234567890123456" -> "•••• 3456". */
export function maskAccountNumber(accountNumber: string | undefined): string | null {
  if (!accountNumber || accountNumber.length < 4) return null
  return `•••• ${accountNumber.slice(-4)}`
}

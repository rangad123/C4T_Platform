import { createHash, timingSafeEqual } from 'node:crypto'
import { PasswordAlgo } from '@prisma/client'
import { env } from '../config/env.js'

/**
 * Verification for passwords carried over from the legacy MySQL platform.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The legacy `users` table stores:
 *
 *     `usr_password` varchar(50) NOT NULL
 *
 * Fifty characters. bcrypt needs 60 and Argon2id about 95, so the column has
 * never held either. What fits is unsalted MD5 (32 hex chars) or SHA-1 (40) —
 * both consistent with the CodeIgniter-era PHP application the data comes from
 * (`ci_sessions` gives that away).
 *
 * Argon2 cannot parse those digests. Point `verifyPassword` at a migrated row
 * and it does not return "wrong password", it throws on the hash format — so
 * without this module EVERY legacy user is locked out permanently.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THESE ALGORITHMS ARE BROKEN, AND THAT IS THE POINT
 *
 * Unsalted MD5 and SHA-1 are not password hashing. They are fast, GPU-friendly
 * digests with enormous precomputed rainbow tables; a leaked legacy row is
 * effectively a plaintext password for any common choice.
 *
 * So nothing here ever WRITES one. This module is verify-only. On the first
 * successful legacy sign-in, `auth.service.login` immediately re-hashes the
 * plaintext with Argon2id and flips `passwordAlgo` to ARGON2ID, so each
 * migrated account is upgraded exactly once, invisibly, at the only moment the
 * plaintext is legitimately available. A user who never returns keeps a weak
 * hash — which is why the legacy database should be decommissioned rather than
 * kept as a fallback.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⚠ THE EXACT LEGACY SCHEME IS UNCONFIRMED
 *
 * The schema-only dump proves the column's width and nothing about how it was
 * filled. It was requested and has not been supplied: the answer lives in the
 * CodeIgniter login controller, usually `application/controllers/Login.php` or
 * a `MY_Auth` library, in whatever it passes to md5()/sha1().
 *
 * Until that lands, this module covers the two plausible schemes by digest
 * LENGTH, and supports an optional site-wide pepper via
 * `LEGACY_PASSWORD_PEPPER` for the common CodeIgniter pattern of
 * `md5($salt . $password)`. If the real code turns out to use a PER-USER salt,
 * that salt is not in the dump either and the migration cannot work without it
 * — in that case the only honest path is a forced password reset for every
 * legacy account.
 *
 * VERIFY THIS AGAINST REAL DATA BEFORE MIGRATING. One row is enough: take a
 * known account, run `npm run legacy:check <email> <password>` against the
 * legacy database, and confirm it matches.
 */

/** Hex digest lengths that identify each legacy scheme. */
const MD5_HEX_LENGTH = 32
const SHA1_HEX_LENGTH = 40

/**
 * Infers the legacy algorithm from a stored digest, or null if it looks like
 * neither. Used by the migration to set `passwordAlgo` per row without needing
 * the PHP source.
 */
export function detectLegacyAlgo(hash: string): PasswordAlgo | null {
  const value = hash.trim()
  if (!/^[0-9a-fA-F]+$/.test(value)) return null
  if (value.length === MD5_HEX_LENGTH) return PasswordAlgo.LEGACY_MD5
  if (value.length === SHA1_HEX_LENGTH) return PasswordAlgo.LEGACY_SHA1
  return null
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and a length
 * mismatch here means a malformed row rather than a wrong password — so it is
 * checked first and reported as a plain mismatch.
 */
function hexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a.trim().toLowerCase(), 'hex')
  const right = Buffer.from(b.trim().toLowerCase(), 'hex')
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Verifies a plaintext password against a legacy digest.
 *
 * Returns false — never throws — for an unknown algorithm or a malformed row,
 * so a bad migration row reads as "wrong password" rather than a 500.
 */
export function verifyLegacyPassword(
  algo: PasswordAlgo,
  storedHash: string,
  plain: string,
): boolean {
  const node = algo === PasswordAlgo.LEGACY_MD5 ? 'md5' : algo === PasswordAlgo.LEGACY_SHA1 ? 'sha1' : null
  if (!node) return false

  const pepper = env.LEGACY_PASSWORD_PEPPER ?? ''

  // Two orderings, because CodeIgniter code of this era is equally likely to
  // have written md5($salt . $password) or md5($password . $salt). With no
  // pepper configured both collapse to the same plain digest, so this costs one
  // extra hash only where a pepper is actually set.
  const candidates = pepper ? [`${pepper}${plain}`, `${plain}${pepper}`] : [plain]

  return candidates.some((candidate) =>
    hexEquals(createHash(node).update(candidate, 'utf8').digest('hex'), storedHash),
  )
}

/** True when this algorithm must be upgraded after a successful verification. */
export function isLegacyAlgo(algo: PasswordAlgo): boolean {
  return algo === PasswordAlgo.LEGACY_MD5 || algo === PasswordAlgo.LEGACY_SHA1
}

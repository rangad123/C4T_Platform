import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

/**
 * One-click unsubscribe links.
 *
 * ── WHY A SIGNED TOKEN AND NOT A ROW
 *
 * The link has to work from an email client with no session — the recipient
 * clicks it from Gmail, not from inside the app — so it cannot rely on a
 * cookie, and it must not be guessable from a user id. A keyed MAC over the
 * user id gives both with no table to store, expire or clean up.
 *
 * Deliberately no expiry. An unsubscribe link that has gone stale is a
 * recipient who cannot make the email stop, which is precisely the complaint
 * that turns into a spam report and costs the sending domain its reputation.
 *
 * ── THE KEY
 *
 * Derived from `JWT_PRIVATE_KEY` rather than a new secret, so there is one
 * fewer value to provision and rotate, and rotating the signing key
 * invalidates outstanding unsubscribe links along with everything else — which
 * is the conservative direction to fail in. The SHA-256 of the key is used
 * rather than the key itself so the signing material is never handed to a
 * second algorithm directly.
 */
function key(): Buffer {
  return createHash('sha256').update(env.JWT_PRIVATE_KEY).digest()
}

function sign(userId: string): string {
  return createHmac('sha256', key()).update(`unsubscribe:${userId}`).digest('base64url')
}

/** The token that identifies a recipient in an unsubscribe link. */
export function unsubscribeToken(userId: string): string {
  return `${Buffer.from(userId).toString('base64url')}.${sign(userId)}`
}

/** The full link, ready to put in an email. */
export function unsubscribeUrl(userId: string): string {
  return `${env.WEB_PUBLIC_URL}/email-preferences?token=${encodeURIComponent(unsubscribeToken(userId))}`
}

/** The user id a token vouches for, or null if it does not verify. */
export function verifyUnsubscribeToken(token: string): string | null {
  const [encoded, mac] = token.split('.')
  if (!encoded || !mac) return null

  let userId: string
  try {
    userId = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!userId) return null

  const expected = Buffer.from(sign(userId))
  const received = Buffer.from(mac)
  // `timingSafeEqual` throws on a length mismatch, which is itself a leak-free
  // rejection — a token of the wrong length was never going to verify.
  if (expected.length !== received.length) return null
  return timingSafeEqual(expected, received) ? userId : null
}

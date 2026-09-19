import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Role } from '@prisma/client'
import { env } from '../config/env.js'
import { UnauthorizedError } from './errors.js'
import { privateKeyPem, publicKeyPem, keyId } from './keys.js'

export const TOKEN_ISSUER = 'crowd4test-api'
export const TOKEN_AUDIENCE = 'crowd4test-app'

/**
 * Access token claims.
 *
 * `sid` is the point of the whole design: the token names a Session row, and
 * the API refuses it the moment that row stops being live. A valid signature is
 * necessary but not sufficient.
 *
 * `role` is a NON-AUTHORITATIVE hint, present only so the Next.js middleware
 * can pick a redirect without a round trip. The API never reads it — it takes
 * role and permissions from the database on every request. Do not be tempted.
 */
export interface AccessTokenClaims {
  sub: string
  sid: string
  role: Role
  jti: string
  iat: number
  exp: number
  iss: string
  aud: string
}

export function signAccessToken(input: { userId: string; sessionId: string; role: Role }): string {
  return jwt.sign(
    { sid: input.sessionId, role: input.role, jti: crypto.randomUUID() },
    privateKeyPem,
    {
      algorithm: 'RS256',
      keyid: keyId,
      subject: input.userId,
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: env.JWT_ACCESS_TTL,
    } as jwt.SignOptions,
  )
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  let claims: AccessTokenClaims
  try {
    claims = jwt.verify(token, publicKeyPem, {
      // Pinning the algorithm is not optional. Without it a caller could
      // present an HS256 token signed with the public key as its secret.
      algorithms: ['RS256'],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    }) as AccessTokenClaims
  } catch {
    throw new UnauthorizedError('Invalid or expired access token')
  }

  if (!claims.sid || !claims.sub) {
    throw new UnauthorizedError('Access token is missing required claims')
  }
  return claims
}

/**
 * Refresh tokens are opaque random strings, never JWTs. Only the SHA-256 hash
 * is persisted, so a database leak does not hand an attacker live sessions.
 */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(48).toString('base64url')
  return { raw, hash: hashToken(raw) }
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/** Single-use tokens for password reset and email verification. */
export function generateOpaqueToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url')
  return { raw, hash: hashToken(raw) }
}

/** Parses "30d" / "15m" / "3600" into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(input.trim())
  if (!match) throw new Error(`Invalid duration: ${input}`)
  const value = Number(match[1])
  const unit = match[2] ?? 's'
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return value * (multipliers[unit] ?? 1000)
}

export const ACCESS_TTL_MS = parseDuration(env.JWT_ACCESS_TTL)
/** Hard ceiling on a session's life, however active it is. */
export const SESSION_ABSOLUTE_TTL_MS = parseDuration(env.SESSION_ABSOLUTE_TTL)
/** Sliding window — a session with no refresh inside this period lapses. */
export const SESSION_IDLE_TTL_MS = parseDuration(env.SESSION_IDLE_TTL)

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000 // 1 hour
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * An HRMS invitation reuses the reset-token table, but not its hour.
 *
 * A reset is short-lived because the person asking is sitting at the screen.
 * An invitation lands in the inbox of someone who has not started yet, may be
 * on notice elsewhere, and is not waiting for it — an hour would mean most
 * invitations expiring before they are opened, and an admin re-sending them
 * one by one.
 */
export const HR_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

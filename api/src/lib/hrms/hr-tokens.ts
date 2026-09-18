import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { HrRole } from '@prisma/client'
import { env } from '../../config/env.js'
import { UnauthorizedError } from '../errors.js'
import { hashToken, parseDuration } from '../tokens.js'

/**
 * HRMS access/session tokens — structurally mirrors lib/tokens.ts (same
 * claim shape, same rotation-friendly refresh-token design) but signed with
 * `HRMS_JWT_SECRET` (HS256), not the platform's RS256 keypair.
 *
 * WHY HS256 HERE WHEN THE PLATFORM USES RS256. The platform's own comment
 * (lib/keys.ts) explains RS256 as letting the Next.js frontend verify a
 * token without being able to mint one. That concern does not apply to HRMS:
 * proxy.ts never verifies the HR token's signature at all, only whether the
 * cookie is present — exactly the platform's own "this is not the
 * authorization boundary" pattern (see proxy.ts's top comment). The real
 * check happens once, in this API, via hrAuthenticate. With no second
 * verifier, a shared HMAC secret costs nothing and needs no keypair
 * generation script for an internal-only tool.
 *
 * `hashToken`/`parseDuration` are imported directly from lib/tokens.ts — pure
 * crypto/parsing utilities with no platform-specific typing, safe to reuse
 * without pulling in anything about User or Role.
 */

export const HR_TOKEN_ISSUER = 'crowd4test-hrms'
export const HR_TOKEN_AUDIENCE = 'crowd4test-hrms-app'

export const HR_ACCESS_TTL = '15m'
export const HR_SESSION_ABSOLUTE_TTL = '30d'
export const HR_SESSION_IDLE_TTL = '7d'

export const HR_ACCESS_TTL_MS = parseDuration(HR_ACCESS_TTL)
export const HR_SESSION_ABSOLUTE_TTL_MS = parseDuration(HR_SESSION_ABSOLUTE_TTL)
export const HR_SESSION_IDLE_TTL_MS = parseDuration(HR_SESSION_IDLE_TTL)

export interface HrAccessTokenClaims {
  sub: string
  sid: string
  role: HrRole
  jti: string
  iat: number
  exp: number
  iss: string
  aud: string
}

export function signHrAccessToken(input: {
  employeeId: string
  sessionId: string
  role: HrRole
}): string {
  return jwt.sign(
    { sid: input.sessionId, role: input.role, jti: crypto.randomUUID() },
    env.HRMS_JWT_SECRET,
    {
      algorithm: 'HS256',
      subject: input.employeeId,
      issuer: HR_TOKEN_ISSUER,
      audience: HR_TOKEN_AUDIENCE,
      expiresIn: HR_ACCESS_TTL,
    } as jwt.SignOptions,
  )
}

export function verifyHrAccessToken(token: string): HrAccessTokenClaims {
  let claims: HrAccessTokenClaims
  try {
    claims = jwt.verify(token, env.HRMS_JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: HR_TOKEN_ISSUER,
      audience: HR_TOKEN_AUDIENCE,
    }) as HrAccessTokenClaims
  } catch {
    throw new UnauthorizedError('Invalid or expired session')
  }

  if (!claims.sid || !claims.sub) {
    throw new UnauthorizedError('Session token is missing required claims')
  }
  return claims
}

/** Opaque, never a JWT — only the SHA-256 hash (via lib/tokens.js) is persisted. */
export function generateHrRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(48).toString('base64url')
  return { raw, hash: hashToken(raw) }
}

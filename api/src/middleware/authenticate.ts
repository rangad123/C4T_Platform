import type { Request, Response, NextFunction } from 'express'
import { Role, UserStatus } from '@prisma/client'
import { verifyAccessToken } from '../lib/tokens.js'
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js'
import { prisma } from '../lib/prisma.js'
import { logger } from '../lib/logger.js'

export const ACCESS_COOKIE = 'c4t_access'
export const REFRESH_COOKIE = 'c4t_refresh'

/**
 * How stale `lastUsedAt` is allowed to get before we write to it. Without this
 * throttle every authenticated request would issue an UPDATE, which on a
 * dashboard doing a dozen calls per page view is pure write amplification for
 * no useful precision.
 */
const LAST_USED_WRITE_INTERVAL_MS = 60_000

function extractToken(req: Request): string | null {
  const header = req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  const cookie = req.cookies?.[ACCESS_COOKIE]
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null
}

/**
 * Verifies the RS256 signature, then resolves the session behind it.
 *
 * This is STATEFUL auth: the signature only proves the token was minted by us.
 * Whether it is still *valid* is a property of the `sessions` row it names, and
 * that is checked on every single request. Revoking a session — logout, a
 * password change, an admin suspension, detected token theft — takes effect on
 * the next call rather than whenever the 15-minute token happens to lapse.
 *
 * Role and permissions are read from the database here too, never from the
 * token. A permission granted or withdrawn in the Admin panel applies at once.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req)
  if (!token) throw new UnauthorizedError()

  const claims = verifyAccessToken(token)

  const session = await prisma.session.findUnique({
    where: { id: claims.sid },
    select: {
      id: true,
      userId: true,
      revokedAt: true,
      revokedReason: true,
      absoluteExpiresAt: true,
      idleExpiresAt: true,
      lastUsedAt: true,
      user: {
        select: {
          id: true,
          role: true,
          status: true,
          deletedAt: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
      },
    },
  })

  if (!session) throw new UnauthorizedError('Session no longer exists')

  // The signature already covers `sub`, so a mismatch means something is very
  // wrong. Cheap to check, and worth knowing about.
  if (session.userId !== claims.sub) {
    logger.error(
      { sessionId: claims.sid, tokenSub: claims.sub, sessionUser: session.userId },
      'Access token subject does not match its session — rejecting',
    )
    throw new UnauthorizedError('Invalid access token')
  }

  if (session.revokedAt) {
    throw new UnauthorizedError(
      session.revokedReason === 'token_reuse'
        ? 'This session was ended for security reasons. Please sign in again.'
        : 'Session has been signed out',
    )
  }

  const now = new Date()
  if (session.absoluteExpiresAt <= now) throw new UnauthorizedError('Session expired')
  if (session.idleExpiresAt <= now)
    throw new UnauthorizedError('Session timed out through inactivity')

  const user = session.user
  if (!user || user.deletedAt) throw new UnauthorizedError('Account no longer exists')
  if (user.status === UserStatus.SUSPENDED) throw new ForbiddenError('This account is suspended')
  if (user.status === UserStatus.ARCHIVED) throw new ForbiddenError('This account is deactivated')

  req.user = {
    id: user.id,
    role: user.role,
    // Only SUB_ADMIN is permission-driven; ADMIN bypasses every check and the
    // other roles are scoped by ownership instead.
    permissions: user.role === Role.SUB_ADMIN ? user.permissions.map((p) => p.permission.code) : [],
  }
  req.sessionId = session.id

  // Throttled activity touch. Deliberately not awaited: a failure here must not
  // fail the request the user actually made.
  if (now.getTime() - session.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    void prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: now } })
      .catch((error) =>
        logger.warn({ err: error, sessionId: session.id }, 'Failed to touch session'),
      )
  }

  next()
}

/** Attaches req.user when a valid session is present, but never rejects. */
export async function optionalAuthenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!extractToken(req)) return next()
  try {
    await authenticate(req, res, next)
  } catch {
    next()
  }
}

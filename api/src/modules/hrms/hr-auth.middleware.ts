import type { Request, Response, NextFunction } from 'express'
import { HrRole, HrEmployeeStatus } from '@prisma/client'
import { verifyHrAccessToken } from '../../lib/hrms/hr-tokens.js'
import { UnauthorizedError, ForbiddenError } from '../../lib/errors.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'

/**
 * HRMS's own authentication/authorization — structurally mirrors
 * middleware/authenticate.ts + authorize.ts, but reads HrSession/HrEmployee
 * and a completely separate cookie pair. Never mix these with the platform's
 * `authenticate`/`requireRole` on the same route: an HR request has no
 * platform session, and vice versa.
 */

export const HR_ACCESS_COOKIE = 'hrms_access'
export const HR_REFRESH_COOKIE = 'hrms_refresh'

const LAST_USED_WRITE_INTERVAL_MS = 60_000

function extractToken(req: Request): string | null {
  const header = req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  const cookie = req.cookies?.[HR_ACCESS_COOKIE]
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null
}

/**
 * Verifies the HS256 signature, then resolves the session behind it — the
 * signature only proves this API minted the token; whether it is still valid
 * is a property of the HrSession row, checked on every request so a logout
 * or a status change takes effect immediately rather than at token expiry.
 */
export async function hrAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req)
  if (!token) throw new UnauthorizedError()

  const claims = verifyHrAccessToken(token)

  const session = await prisma.hrSession.findUnique({
    where: { id: claims.sid },
    select: {
      id: true,
      employeeId: true,
      revokedAt: true,
      revokedReason: true,
      absoluteExpiresAt: true,
      idleExpiresAt: true,
      lastUsedAt: true,
      employee: { select: { id: true, role: true, status: true, deletedAt: true } },
    },
  })

  if (!session) throw new UnauthorizedError('Session no longer exists')

  if (session.employeeId !== claims.sub) {
    logger.error(
      { sessionId: claims.sid, tokenSub: claims.sub, sessionEmployee: session.employeeId },
      'HRMS access token subject does not match its session — rejecting',
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

  const employee = session.employee
  if (!employee || employee.deletedAt) throw new UnauthorizedError('Account no longer exists')
  if (
    employee.status === HrEmployeeStatus.RESIGNED ||
    employee.status === HrEmployeeStatus.TERMINATED
  ) {
    throw new ForbiddenError('This account no longer has access to HRMS')
  }

  req.hrEmployee = { id: employee.id, role: employee.role }
  req.hrSessionId = session.id

  if (now.getTime() - session.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    void prisma.hrSession
      .update({ where: { id: session.id }, data: { lastUsedAt: now } })
      .catch((error: unknown) =>
        logger.warn({ err: error, sessionId: session.id }, 'Failed to touch HR session'),
      )
  }

  next()
}

/**
 * Coarse role gate. ADMIN sees the whole Admin Portal. ACCOUNT_MANAGER and
 * EMPLOYEE share the Employee Portal; the manager-vs-own-record distinction
 * for a given resource (e.g. approving a report's leave request) is an
 * ownership check inside the service, not a route-level gate — the same
 * three-layer split the platform's own authorize.ts documents.
 */
export function requireHrRole(...roles: HrRole[]) {
  return function hrRoleGuard(req: Request, _res: Response, next: NextFunction): void {
    if (!req.hrEmployee) throw new UnauthorizedError()
    if (!roles.includes(req.hrEmployee.role)) {
      throw new ForbiddenError('Your role does not have access to this resource')
    }
    next()
  }
}

export const HR_ADMIN_ROLES: HrRole[] = [HrRole.ADMIN]

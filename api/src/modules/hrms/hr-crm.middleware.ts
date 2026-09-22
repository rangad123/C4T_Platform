import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'
import { hasCrmCapability, type CrmCapability } from '../../lib/hrms/hr-crm-capabilities.js'

/**
 * The CRM module gate. Runs after `hrAuthenticate`, before any CRM route
 * touches data.
 *
 * Reads `crmEnabled`/`crmRole` fresh from the database on every request —
 * deliberately not from the access token, which `hrAuthenticate` already
 * trusts for `role` because a role change is rare and tolerating up to 15
 * minutes of staleness there was an accepted trade-off. A module being
 * switched off is exactly the kind of change that must be enforced on the
 * very next request, not at the token's next refresh, so this is a real
 * database read every time — the same reasoning `hrAuthenticate` itself
 * already applies to session revocation.
 *
 * A disabled or unconfigured employee gets a 403 with a plain reason, never
 * a silent empty result — this is the backend half of "no direct URL/API
 * access", independent of whatever the frontend nav happens to show.
 */
export async function requireCrmAccess(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.hrEmployee) throw new UnauthorizedError()

  const employee = await prisma.hrEmployee.findFirst({
    where: { id: req.hrEmployee.id, deletedAt: null },
    select: { crmEnabled: true, crmRole: true },
  })
  if (!employee?.crmEnabled) {
    throw new ForbiddenError('CRM is not enabled for this account')
  }
  if (!employee.crmRole) {
    throw new ForbiddenError('CRM access has not been fully configured for this account yet')
  }

  req.crmAccess = { role: employee.crmRole }
  next()
}

/**
 * The per-action gate, run after `requireCrmAccess`. Ownership scoping for
 * `'own'`-tier capabilities (an EMPLOYEE editing only their assigned leads)
 * happens in the service layer, which already has the specific lead in
 * hand — this only refuses a tier that has no version of the capability at
 * all, e.g. an EMPLOYEE trying to reach a delete or catalog route.
 */
export function requireCrmCapability(capability: CrmCapability) {
  return function crmCapabilityGuard(req: Request, _res: Response, next: NextFunction): void {
    if (!req.crmAccess) throw new UnauthorizedError()
    if (!hasCrmCapability(req.crmAccess.role, capability)) {
      throw new ForbiddenError('You do not have permission to do that in CRM')
    }
    next()
  }
}

import 'server-only'
import { cache } from 'react'
import { hrExternalRedirect } from './hr-external-redirect'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { HR_ROLE_HOME, type HrRole, type PublicHrEmployee } from './hr-types'
import { hasCrmCapability, type CrmCapability } from './hr-crm-capabilities'

/**
 * The HRMS authorization boundary — mirrors `lib/auth/session.ts` exactly,
 * against the HR API instead of the platform's. `serverFetch` needs no HRMS
 * variant: it forwards whatever cookies the incoming request carries and
 * targets `${API_ORIGIN}/v1/${path}`, so `serverFetch('hrms/auth/me')`
 * reaches `GET /v1/hrms/auth/me` correctly. The extra `c4t_*` cookies (if
 * any) ride along unread — `hrAuthenticate` only ever looks at `hrms_access`.
 *
 * Same "signed out" vs. "could not tell" split as the platform session, for
 * the same reason: a page that requires an employee must not treat an API
 * hiccup as a sign-out, and the login page must not crash when the read
 * fails.
 */
type HrSessionRead = { ok: true; employee: PublicHrEmployee | null } | { ok: false; error: unknown }

const readHrSession = cache(async (): Promise<HrSessionRead> => {
  try {
    const employee = await serverFetch<PublicHrEmployee>('hrms/auth/me')
    return { ok: true, employee }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { ok: true, employee: null }
    return { ok: false, error }
  }
})

/** Non-throwing read. `null` means "not signed in, as far as we can tell". */
export const getHrEmployee = async (): Promise<PublicHrEmployee | null> => {
  const read = await readHrSession()
  return read.ok ? read.employee : null
}

/** Redirects to /login when there is no live HR session — and only then. */
export async function requireHrEmployee(returnTo?: string): Promise<PublicHrEmployee> {
  const read = await readHrSession()
  if (!read.ok) throw read.error

  if (!read.employee) {
    /*
      These run while a page renders, so Next answers them with a real HTTP
      redirect and the browser's follow-up request passes through the host
      rewrite correctly — unlike the Server Action redirects this helper was
      written for. Routed through it anyway so that every HRMS redirect to a
      browser-facing path is built the same way, and so this resolves locally
      too, where there is no hrms hostname to rewrite from.
    */
    hrExternalRedirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login')
  }
  return read.employee
}

/** Requires one of the given roles, else sends the employee to their own home. */
export async function requireHrRole(roles: HrRole[], returnTo?: string): Promise<PublicHrEmployee> {
  const employee = await requireHrEmployee(returnTo)
  if (!roles.includes(employee.role)) {
    hrExternalRedirect(HR_ROLE_HOME[employee.role])
  }
  return employee
}

/**
 * Gate for the CRM portal. Any signed-in employee may reach `/crm` at the
 * `HrRole` layer — `crmEnabled` is the real gate, and it is per-employee, not
 * per-`HrRole` (an ADMIN can have CRM off; an ordinary EMPLOYEE can have it
 * on). Sends someone whose module is off back to their normal portal home,
 * the same "gate then redirect" shape `requireHrRole` uses above.
 *
 * This is a convenience for the frontend, same as every other HRMS route
 * guard — the real enforcement is the API's own `requireCrmAccess`
 * middleware, which every CRM route runs independently.
 */
export async function requireCrmAccess(returnTo?: string): Promise<PublicHrEmployee> {
  const employee = await requireHrEmployee(returnTo)
  if (!employee.crmEnabled || !employee.crmRole) {
    hrExternalRedirect(HR_ROLE_HOME[employee.role])
  }
  return employee
}

/**
 * Gate for one CRM section (Catalog, Add Employee) that needs a specific
 * capability, not just the module being on — an EMPLOYEE-tier visitor who
 * finds the URL for `/crm/catalog` by hand is sent back to `/crm`, the same
 * "gate then redirect" shape as every other guard here. Convenience only —
 * the API's own `requireCrmCapability` middleware is what actually enforces
 * this on every request.
 */
export async function requireCrmCapability(
  capability: CrmCapability,
  returnTo?: string,
): Promise<PublicHrEmployee> {
  const employee = await requireCrmAccess(returnTo)
  if (!hasCrmCapability(employee.crmRole!, capability)) {
    hrExternalRedirect('/crm')
  }
  return employee
}

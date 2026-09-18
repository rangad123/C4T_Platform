import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { HR_ROLE_HOME, type HrRole, type PublicHrEmployee } from './hr-types'

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
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login'
    redirect(target)
  }
  return read.employee
}

/** Requires one of the given roles, else sends the employee to their own home. */
export async function requireHrRole(roles: HrRole[], returnTo?: string): Promise<PublicHrEmployee> {
  const employee = await requireHrEmployee(returnTo)
  if (!roles.includes(employee.role)) {
    redirect(HR_ROLE_HOME[employee.role])
  }
  return employee
}

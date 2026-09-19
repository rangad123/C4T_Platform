/**
 * HRMS's own domain types — mirrors `lib/api/types.ts`'s shape, deliberately
 * NOT importing from it. `HrRole` shares no values with the platform's
 * `Role` (`ADMIN | ACCOUNT_MANAGER | EMPLOYEE` vs.
 * `USER | CUSTOMER | TESTER | ADMIN | SUB_ADMIN`), so a shared type would
 * either be a lie or a union nothing here wants.
 */

export type HrRole = 'ADMIN' | 'ACCOUNT_MANAGER' | 'EMPLOYEE'

export type HrEmployeeStatus = 'ACTIVE' | 'RESIGNED' | 'TERMINATED'

/** Shape returned by GET /v1/hrms/auth/me (and by the login/refresh routes). */
export interface PublicHrEmployee {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  role: HrRole
  status: HrEmployeeStatus
  profilePictureFileId: string | null
  /** Whether this employee is expected to fill in a timesheet at all. */
  timesheetRequired: boolean
}

/** Which portal each role lands on after sign-in. */
export const HR_ROLE_HOME: Readonly<Record<HrRole, string>> = {
  ADMIN: '/admin',
  ACCOUNT_MANAGER: '/employee',
  EMPLOYEE: '/employee',
}

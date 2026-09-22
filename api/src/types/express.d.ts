import type { Role, HrRole } from '@prisma/client'
import type { CrmRole } from '../lib/hrms/hr-crm-capabilities.js'

declare global {
  namespace Express {
    interface AuthenticatedUser {
      id: string
      role: Role
      /** Permission codes. Populated for SUB_ADMIN; ADMIN bypasses checks. */
      permissions: string[]
    }

    /**
     * HRMS's own request identity — deliberately a separate shape from
     * `AuthenticatedUser`, not a union or an extension of it. An HR request
     * never carries a platform `user`, and a platform request never carries
     * `hrEmployee`; the two are set by entirely different middleware
     * (`authenticate` vs `hrAuthenticate`) reading entirely different cookies.
     */
    interface AuthenticatedHrEmployee {
      id: string
      role: HrRole
    }

    interface Request {
      /** Present only after the `authenticate` middleware has run. */
      user?: AuthenticatedUser
      /** Id of the `sessions` row backing this request. Set alongside `user`. */
      sessionId?: string
      /** Present only after the `hrAuthenticate` middleware has run. */
      hrEmployee?: AuthenticatedHrEmployee
      /** Id of the `hr_sessions` row backing this request. Set alongside `hrEmployee`. */
      hrSessionId?: string
      /**
       * Present only after `requireCrmAccess` has run. A separate property,
       * not folded into `hrEmployee`, so it stays obvious which routes have
       * actually checked CRM access — `crmEnabled`/`crmRole` are not on the
       * JWT (unlike `role`), because they must take effect immediately on an
       * admin's toggle rather than waiting for the access token to expire, so
       * this is always a fresh read.
       */
      crmAccess?: { role: CrmRole }
      /** Correlation id, set by the requestId middleware and echoed to clients. */
      requestId: string
    }
  }
}

export {}

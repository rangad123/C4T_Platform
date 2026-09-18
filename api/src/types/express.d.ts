import type { Role, HrRole } from '@prisma/client'

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
      /** Correlation id, set by the requestId middleware and echoed to clients. */
      requestId: string
    }
  }
}

export {}

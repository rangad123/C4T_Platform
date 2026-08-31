/**
 * Response envelope contract with the Express API.
 *
 * Kept hand-written and minimal on purpose. The API is a separate service, so
 * these types are a *claim* about its shape, not a guarantee — parse anything
 * security-relevant with Zod at the call site rather than trusting the cast.
 *
 * TODO: when the API grows an OpenAPI spec, generate this file instead.
 */

export interface ApiSuccess<T> {
  data: T
  meta?: PageMeta & Record<string, unknown>
}

export interface ApiFailure {
  error: {
    code: string
    message: string
    details?: unknown
  }
  requestId: string
}

export interface PageMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface ValidationDetail {
  field: string
  message: string
  code: string
}

// ─── Domain types ────────────────────────────────────────────────────────────
// Mirrors the API's Prisma enums. Kept as unions rather than importing from the
// backend so the two services stay independently deployable.

export type Role = 'USER' | 'CUSTOMER' | 'TESTER' | 'ADMIN' | 'SUB_ADMIN'

export type UserStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'

/** Shape returned by GET /v1/auth/me. */
export interface SessionUser {
  id: string
  email: string
  role: Role
  status: UserStatus
  firstName: string | null
  lastName: string | null
  emailVerified: boolean
  /** Drives the header avatar. Null until a picture is uploaded. */
  avatarFileId: string | null
  permissions: string[]
  organisationId: string | null
  testerProfileId: string | null
}

export interface ActiveSession {
  id: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  lastUsedAt: string
  absoluteExpiresAt: string
  idleExpiresAt: string
  isCurrent: boolean
}

/** Which landing page each role belongs on after sign-in. */
export const ROLE_HOME: Readonly<Record<Role, string>> = {
  ADMIN: '/app/admin',
  SUB_ADMIN: '/app/admin',
  CUSTOMER: '/app/customer',
  TESTER: '/app/tester',
  USER: '/app/onboarding',
}

/**
 * A failed API response, as an Error.
 *
 * Lives here rather than beside a fetch wrapper because both the server helper
 * and any future browser client need it, and it depends only on `ApiFailure`
 * below. It previously sat in `api/client.ts`, which was otherwise an unused
 * browser fetch layer — the class was the only live thing in a 163-line file.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  readonly requestId?: string

  constructor(status: number, body: Partial<ApiFailure>) {
    super(body.error?.message ?? `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = body.error?.code ?? 'UNKNOWN'
    this.details = body.error?.details
    this.requestId = body.requestId
  }

  /** True when refreshing the session could plausibly fix this. */
  get isRetryableAuthFailure(): boolean {
    // Only an expired access token is worth retrying. A revoked, expired or
    // reused session will fail again — see the 401 table in api/docs/API.md.
    return this.status === 401 && this.code === 'UNAUTHORIZED'
  }

  get isValidationError(): boolean {
    return this.status === 422
  }
}

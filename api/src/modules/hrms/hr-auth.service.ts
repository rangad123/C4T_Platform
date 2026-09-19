import { HrEmployeeStatus } from '@prisma/client'
import type { HrRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { hashPassword, verifyPassword, needsRehash } from '../../lib/password.js'
import {
  signHrAccessToken,
  generateHrRefreshToken,
  HR_SESSION_ABSOLUTE_TTL_MS,
  HR_SESSION_IDLE_TTL_MS,
} from '../../lib/hrms/hr-tokens.js'
import {
  hashToken,
  generateOpaqueToken,
  PASSWORD_RESET_TTL_MS,
  HR_INVITATION_TTL_MS,
} from '../../lib/tokens.js'
import { sendMail, hrPasswordResetEmail, hrInvitationEmail } from '../../lib/mailer.js'
import {
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  NotFoundError,
} from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

/**
 * HRMS's own login/session service — structurally mirrors
 * modules/auth/auth.service.ts (uniform failure timing, lockout, rotation
 * with reuse detection) but reads/writes HrEmployee and HrSession only.
 *
 * There is deliberately no Google sign-in, and no legacy password path: the
 * accounts imported from the old HR system had unsalted MD5 digests, which
 * scripts/hrms/migrate-legacy.ts deliberately did not carry across. Those
 * employees hold a generated password they never chose, which is exactly why
 * the reset flow below exists.
 */

const MAX_FAILED_LOGINS = 8
const LOCKOUT_MS = 15 * 60 * 1000

export interface HrSessionTokens {
  accessToken: string
  refreshToken: string
  sessionId: string
  refreshExpiresAt: Date
}

export type HrRevokeReason =
  'logout' | 'logout_all' | 'token_reuse' | 'password_changed' | 'password_reset' | 'admin'

export interface PublicHrEmployee {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  role: HrRole
  status: HrEmployeeStatus
  profilePictureFileId: string | null
  timesheetRequired: boolean
}

async function loadPublicEmployee(employeeId: string): Promise<PublicHrEmployee> {
  const employee = await prisma.hrEmployee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      status: true,
      profilePictureFileId: true,
      // Drives whether the Timesheet section is offered at all — a UI decision
      // the portals need on every render, so it rides with the session rather
      // than costing a second fetch per page.
      timesheetRequired: true,
    },
  })
  if (!employee) throw new NotFoundError('Employee')
  return employee
}

async function openSession(
  employee: PublicHrEmployee,
  context: { userAgent?: string; ipAddress?: string },
): Promise<HrSessionTokens> {
  const { raw, hash } = generateHrRefreshToken()
  const now = Date.now()
  const absoluteExpiresAt = new Date(now + HR_SESSION_ABSOLUTE_TTL_MS)
  const idleExpiresAt = new Date(now + HR_SESSION_IDLE_TTL_MS)

  const session = await prisma.hrSession.create({
    data: {
      employeeId: employee.id,
      refreshTokenHash: hash,
      absoluteExpiresAt,
      idleExpiresAt,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      ipAddress: context.ipAddress ?? null,
    },
    select: { id: true },
  })

  const accessToken = signHrAccessToken({
    employeeId: employee.id,
    sessionId: session.id,
    role: employee.role,
  })

  return {
    accessToken,
    refreshToken: raw,
    sessionId: session.id,
    refreshExpiresAt: absoluteExpiresAt < idleExpiresAt ? absoluteExpiresAt : idleExpiresAt,
  }
}

function assertUsableStatus(status: HrEmployeeStatus): void {
  if (status === HrEmployeeStatus.RESIGNED || status === HrEmployeeStatus.TERMINATED) {
    throw new ForbiddenError('This account no longer has access to HRMS')
  }
}

export async function login(
  input: { email: string; password: string },
  context: { userAgent?: string; ipAddress?: string },
): Promise<{ employee: PublicHrEmployee; tokens: HrSessionTokens }> {
  const record = await prisma.hrEmployee.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      passwordHash: true,
      status: true,
      deletedAt: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  })

  // Uniform failure message and a real hash comparison on the miss path, so
  // response timing does not reveal whether the account exists — same
  // technique as the platform's own login.
  if (!record || record.deletedAt) {
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
      input.password,
    )
    throw new UnauthorizedError('Incorrect email or password')
  }

  if (record.lockedUntil && record.lockedUntil > new Date()) {
    throw new ForbiddenError('Too many failed attempts. Try again in a few minutes.')
  }

  const valid = await verifyPassword(record.passwordHash, input.password)
  if (!valid) {
    const nextCount = record.failedLoginCount + 1
    await prisma.hrEmployee.update({
      where: { id: record.id },
      data: {
        failedLoginCount: nextCount,
        lockedUntil: nextCount >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    })
    throw new UnauthorizedError('Incorrect email or password')
  }

  assertUsableStatus(record.status)

  const rehash = needsRehash(record.passwordHash) ? await hashPassword(input.password) : undefined

  await prisma.hrEmployee.update({
    where: { id: record.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      ...(rehash ? { passwordHash: rehash } : {}),
    },
  })

  const employee = await loadPublicEmployee(record.id)
  const tokens = await openSession(employee, context)
  return { employee, tokens }
}

async function revokeSessionById(sessionId: string, reason: HrRevokeReason): Promise<void> {
  await prisma.hrSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
}

/**
 * Rotates the refresh token in place and mints a fresh access token. Reuse
 * detection: presenting an already-superseded hash means the token was
 * captured and replayed, so the session is destroyed rather than rotated —
 * identical logic to the platform's own `refresh`.
 */
export async function refresh(
  rawToken: string,
  context: { userAgent?: string; ipAddress?: string },
): Promise<{ employee: PublicHrEmployee; tokens: HrSessionTokens }> {
  const tokenHash = hashToken(rawToken)

  const session = await prisma.hrSession.findFirst({
    where: { OR: [{ refreshTokenHash: tokenHash }, { previousTokenHash: tokenHash }] },
    select: {
      id: true,
      employeeId: true,
      refreshTokenHash: true,
      previousTokenHash: true,
      rotationCount: true,
      revokedAt: true,
      absoluteExpiresAt: true,
      idleExpiresAt: true,
      employee: { select: { status: true, deletedAt: true } },
    },
  })

  if (!session) throw new UnauthorizedError('Invalid refresh token')

  if (session.previousTokenHash === tokenHash) {
    await revokeSessionById(session.id, 'token_reuse')
    logger.warn(
      {
        sessionId: session.id,
        employeeId: session.employeeId,
        rotationCount: session.rotationCount,
      },
      'HRMS refresh token reuse detected — session destroyed',
    )
    throw new UnauthorizedError(
      'This session was ended for security reasons. Please sign in again.',
    )
  }

  if (session.revokedAt) throw new UnauthorizedError('Session has been signed out')

  const now = new Date()
  if (session.absoluteExpiresAt <= now) throw new UnauthorizedError('Session expired')
  if (session.idleExpiresAt <= now)
    throw new UnauthorizedError('Session timed out through inactivity')

  if (!session.employee || session.employee.deletedAt) {
    throw new UnauthorizedError('Account no longer exists')
  }
  assertUsableStatus(session.employee.status)

  const employee = await loadPublicEmployee(session.employeeId)
  const { raw, hash } = generateHrRefreshToken()

  const nextIdle = new Date(now.getTime() + HR_SESSION_IDLE_TTL_MS)
  const idleExpiresAt = nextIdle < session.absoluteExpiresAt ? nextIdle : session.absoluteExpiresAt

  await prisma.hrSession.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: hash,
      previousTokenHash: session.refreshTokenHash,
      rotationCount: { increment: 1 },
      lastUsedAt: now,
      idleExpiresAt,
      userAgent: context.userAgent?.slice(0, 512) ?? undefined,
      ipAddress: context.ipAddress ?? undefined,
    },
  })

  const accessToken = signHrAccessToken({
    employeeId: employee.id,
    sessionId: session.id,
    role: employee.role,
  })

  return {
    employee,
    tokens: {
      accessToken,
      refreshToken: raw,
      sessionId: session.id,
      refreshExpiresAt: idleExpiresAt,
    },
  }
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return
  const tokenHash = hashToken(rawToken)
  await prisma.hrSession.updateMany({
    where: { refreshTokenHash: tokenHash, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'logout' },
  })
}

export async function changePassword(
  employeeId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string,
): Promise<void> {
  const employee = await prisma.hrEmployee.findUnique({
    where: { id: employeeId },
    select: { passwordHash: true },
  })
  if (!employee) throw new NotFoundError('Employee')

  const valid = await verifyPassword(employee.passwordHash, currentPassword)
  if (!valid) throw new UnauthorizedError('Current password is incorrect')
  if (newPassword.length < 12) {
    throw new BadRequestError('Password must be at least 12 characters')
  }

  const passwordHash = await hashPassword(newPassword)

  await prisma.$transaction([
    prisma.hrEmployee.update({ where: { id: employeeId }, data: { passwordHash } }),
    prisma.hrSession.updateMany({
      where: {
        employeeId,
        revokedAt: null,
        ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: 'password_changed' },
    }),
  ])
}

// ─── Password reset ──────────────────────────────────────────────────────────

/**
 * Always reports success to the caller, whether or not the address matched —
 * otherwise this endpoint answers "does this person work here?" to anyone who
 * asks. The returned id is for the controller's audit entry only.
 */
export async function forgotPassword(email: string): Promise<{ employeeId: string | null }> {
  const employee = await prisma.hrEmployee.findUnique({
    where: { email },
    select: { id: true, email: true, deletedAt: true, status: true },
  })
  // A resigned or terminated employee does not get a route back in.
  if (!employee || employee.deletedAt || employee.status !== HrEmployeeStatus.ACTIVE) {
    return { employeeId: null }
  }

  // Only the newest link should work.
  await prisma.hrPasswordResetToken.updateMany({
    where: { employeeId: employee.id, usedAt: null },
    data: { usedAt: new Date() },
  })

  const { raw, hash } = generateOpaqueToken()
  await prisma.hrPasswordResetToken.create({
    data: {
      employeeId: employee.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    },
  })

  await sendMail(hrPasswordResetEmail(employee.email, raw))
  return { employeeId: employee.id }
}

/**
 * Sends a new member of staff the link that lets them choose their first
 * password. Also the "resend" path — an invitation that expired, or went to a
 * typo'd address that has since been corrected.
 *
 * Unlike `forgotPassword`, this is ADMIN-only and says plainly when it will
 * not send. That endpoint hides whether an address belongs to a member of
 * staff because anyone can call it; here the caller is HR, already looking at
 * the record, and a silent no-op would just leave them wondering why nothing
 * arrived.
 */
export async function inviteEmployee(
  employeeId: string,
  invitedById: string,
): Promise<{ email: string }> {
  const [employee, invitedBy] = await Promise.all([
    prisma.hrEmployee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { id: true, email: true, status: true },
    }),
    // Looked up here rather than carried on the request: `hrAuthenticate`
    // attaches only an id and a role, and widening that would mean a name
    // lookup on every HRMS request to serve the handful that print one.
    prisma.hrEmployee.findUnique({
      where: { id: invitedById },
      select: { firstName: true, lastName: true },
    }),
  ])
  if (!employee) throw new NotFoundError('Employee')
  if (employee.status !== HrEmployeeStatus.ACTIVE) {
    throw new BadRequestError('Only an active employee can be invited to sign in')
  }

  // Only the newest link should work — the same rule as a reset, and the
  // reason an expired invitation is re-sent rather than accumulated.
  await prisma.hrPasswordResetToken.updateMany({
    where: { employeeId: employee.id, usedAt: null },
    data: { usedAt: new Date() },
  })

  const { raw, hash } = generateOpaqueToken()
  await prisma.hrPasswordResetToken.create({
    data: {
      employeeId: employee.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + HR_INVITATION_TTL_MS),
    },
  })

  const invitedByName = invitedBy
    ? `${invitedBy.firstName} ${invitedBy.lastName}`.trim()
    : 'Your HR administrator'
  await sendMail(hrInvitationEmail(employee.email, raw, invitedByName))
  return { email: employee.email }
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<string> {
  const stored = await prisma.hrPasswordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true, employeeId: true, expiresAt: true, usedAt: true },
  })

  if (!stored || stored.usedAt) {
    throw new BadRequestError('This reset link is invalid or already used')
  }
  if (stored.expiresAt < new Date()) throw new BadRequestError('This reset link has expired')
  if (newPassword.length < 12) {
    throw new BadRequestError('Password must be at least 12 characters')
  }

  const passwordHash = await hashPassword(newPassword)

  await prisma.$transaction([
    prisma.hrPasswordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
    // Clearing the lockout matters here: someone who forgot their password has
    // usually just failed eight logins trying to remember it.
    prisma.hrEmployee.update({
      where: { id: stored.employeeId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    }),
    prisma.hrSession.updateMany({
      where: { employeeId: stored.employeeId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'password_reset' satisfies HrRevokeReason },
    }),
  ])
  return stored.employeeId
}

export { loadPublicEmployee }

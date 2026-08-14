import {
  Role,
  UserStatus,
  OrgMemberRole,
  OrganisationStatus,
  TesterStatus,
  PasswordAlgo,
} from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { hashPassword, verifyPassword, needsRehash } from '../../lib/password.js'
import { isLegacyAlgo, verifyLegacyPassword } from '../../lib/legacy-password.js'
import type { GoogleIdentity } from '../../lib/oauth/google.js'
import {
  signAccessToken,
  generateRefreshToken,
  generateOpaqueToken,
  hashToken,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  EMAIL_VERIFY_TTL_MS,
} from '../../lib/tokens.js'
import {
  ConflictError,
  UnauthorizedError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js'
import { sendMail, verificationEmail, passwordResetEmail } from '../../lib/mailer.js'
import { logger } from '../../lib/logger.js'
import type { RegisterInput, LoginInput } from './auth.schema.js'

const MAX_FAILED_LOGINS = 8
const LOCKOUT_MS = 15 * 60 * 1000

export interface SessionTokens {
  accessToken: string
  refreshToken: string
  sessionId: string
  refreshExpiresAt: Date
}

/** Reasons a session can be torn down. Stored for support and audit. */
export type RevokeReason =
  | 'logout'
  | 'logout_all'
  | 'token_reuse'
  | 'password_changed'
  | 'password_reset'
  | 'account_suspended'
  | 'account_deleted'
  | 'admin'

export interface PublicUser {
  id: string
  email: string
  role: Role
  status: UserStatus
  firstName: string | null
  lastName: string | null
  emailVerified: boolean
  permissions: string[]
  organisationId: string | null
  testerProfileId: string | null
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Loads the role, permissions and scope needed for a token and for /me. */
async function loadPublicUser(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      firstName: true,
      lastName: true,
      emailVerifiedAt: true,
      permissions: { select: { permission: { select: { code: true } } } },
      orgMemberships: { select: { organisationId: true }, take: 1 },
      testerProfile: { select: { id: true } },
    },
  })
  if (!user) throw new NotFoundError('User')

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    firstName: user.firstName,
    lastName: user.lastName,
    emailVerified: user.emailVerifiedAt !== null,
    permissions: user.permissions.map((p) => p.permission.code),
    organisationId: user.orgMemberships[0]?.organisationId ?? null,
    testerProfileId: user.testerProfile?.id ?? null,
  }
}

/**
 * Opens a new session row and mints the first token pair for it.
 *
 * The access token is only a pointer: it names this session, and every request
 * re-reads the row. Nothing about the user's role or permissions is baked in.
 */
async function openSession(
  user: PublicUser,
  context: { userAgent?: string; ipAddress?: string },
): Promise<SessionTokens> {
  const { raw, hash } = generateRefreshToken()
  const now = Date.now()
  const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_TTL_MS)
  const idleExpiresAt = new Date(now + SESSION_IDLE_TTL_MS)

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hash,
      absoluteExpiresAt,
      idleExpiresAt,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      ipAddress: context.ipAddress ?? null,
    },
    select: { id: true },
  })

  const accessToken = signAccessToken({
    userId: user.id,
    sessionId: session.id,
    role: user.role,
  })

  return {
    accessToken,
    refreshToken: raw,
    sessionId: session.id,
    // The refresh cookie should not outlive the session itself.
    refreshExpiresAt: absoluteExpiresAt < idleExpiresAt ? absoluteExpiresAt : idleExpiresAt,
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export async function register(
  input: RegisterInput,
  context: { userAgent?: string; ipAddress?: string },
): Promise<{ user: PublicUser; tokens: SessionTokens }> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  if (existing) {
    // Registration is not an account-enumeration oracle we can fully close
    // (the UX requires telling people their email is taken), but we say no more
    // than that.
    throw new ConflictError('An account with this email already exists')
  }

  const passwordHash = await hashPassword(input.password)

  const userId = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        role: input.intendedRole,
        status: UserStatus.PENDING_VERIFICATION,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        phone: input.phone ?? null,
        countryCode: input.countryCode ?? null,
      },
      select: { id: true },
    })

    // A CUSTOMER registration also creates the organisation and makes the
    // registrant its owner (§2.4).
    if (input.intendedRole === Role.CUSTOMER && input.organisationName) {
      const base = slugify(input.organisationName) || 'org'
      let slug = base
      for (
        let i = 2;
        await tx.organisation.findUnique({ where: { slug }, select: { id: true } });
        i++
      ) {
        slug = `${base}-${i}`
      }

      const org = await tx.organisation.create({
        data: {
          name: input.organisationName,
          slug,
          status: OrganisationStatus.PENDING,
          contactEmail: input.email,
        },
        select: { id: true },
      })

      await tx.organisationMember.create({
        data: {
          organisationId: org.id,
          userId: user.id,
          orgRole: OrgMemberRole.OWNER,
          joinedAt: new Date(),
        },
      })
    }

    // A TESTER registration opens an application for Admin review (§2.2).
    if (input.intendedRole === Role.TESTER) {
      await tx.testerProfile.create({
        data: {
          userId: user.id,
          status: TesterStatus.APPLIED,
          countryCode: input.countryCode ?? null,
        },
      })
    }

    return user.id
  })

  await sendVerificationEmail(userId, input.email)

  const user = await loadPublicUser(userId)
  const tokens = await openSession(user, context)
  return { user, tokens }
}

// ─── Login ───────────────────────────────────────────────────────────────────

export async function login(
  input: LoginInput,
  context: { userAgent?: string; ipAddress?: string },
): Promise<{ user: PublicUser; tokens: SessionTokens }> {
  const record = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      passwordHash: true,
      passwordAlgo: true,
      status: true,
      deletedAt: true,
      failedLoginCount: true,
      lockedUntil: true,
      // Used only to tell an OAuth-only user WHICH provider to use, rather
      // than reporting a wrong password for one they never set.
      oauthAccounts: { select: { provider: true } },
    },
  })

  // Uniform failure message and a real hash comparison on the miss path, so
  // response timing does not reveal whether the account exists.
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

  /**
   * An account created through Google has no password. Rejecting it with
   * "incorrect email or password" would be a lie that sends the user round a
   * reset loop for a credential that does not exist, so it is named instead.
   *
   * This leaks that the address is registered — but so does the reset form, and
   * the alternative is a support ticket from every Google user who forgets how
   * they signed up.
   */
  if (!record.passwordHash) {
    const provider = record.oauthAccounts[0]?.provider
    throw new UnauthorizedError(
      provider === 'google'
        ? 'This account uses Google sign-in. Use the "Continue with Google" button.'
        : 'This account has no password set. Reset your password to create one.',
    )
  }

  /**
   * Legacy rows from the MySQL platform hold an MD5 or SHA-1 digest that Argon2
   * cannot parse — see lib/legacy-password.ts. Route by the recorded algorithm
   * rather than guessing from the hash on every login.
   */
  const usingLegacy = isLegacyAlgo(record.passwordAlgo)
  const valid = usingLegacy
    ? verifyLegacyPassword(record.passwordAlgo, record.passwordHash, input.password)
    : await verifyPassword(record.passwordHash, input.password)

  if (!valid) {
    const nextCount = record.failedLoginCount + 1
    await prisma.user.update({
      where: { id: record.id },
      data: {
        failedLoginCount: nextCount,
        lockedUntil: nextCount >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    })
    throw new UnauthorizedError('Incorrect email or password')
  }

  if (record.status === UserStatus.SUSPENDED) throw new ForbiddenError('This account is suspended')
  if (record.status === UserStatus.DEACTIVATED)
    throw new ForbiddenError('This account is deactivated')

  /**
   * UPGRADE THE HASH. This is the only moment the plaintext is legitimately in
   * memory, so it is the only moment a stored digest can be strengthened
   * without asking the user for anything.
   *
   * Two cases converge here:
   *   - a legacy MD5/SHA-1 row, which must be replaced outright; and
   *   - an Argon2 hash produced under weaker parameters than we now use.
   *
   * `needsRehash` only understands Argon2 encodings, so it is not consulted for
   * legacy rows — those are always rehashed.
   */
  const rehash =
    usingLegacy || needsRehash(record.passwordHash)
      ? await hashPassword(input.password)
      : undefined

  await prisma.user.update({
    where: { id: record.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      ...(rehash ? { passwordHash: rehash, passwordAlgo: PasswordAlgo.ARGON2ID } : {}),
    },
  })

  const user = await loadPublicUser(record.id)
  const tokens = await openSession(user, context)
  return { user, tokens }
}

// ─── Refresh (with rotation + reuse detection) ───────────────────────────────

/**
 * Rotates the refresh token in place on its session and mints a fresh access
 * token. The session id never changes, so "sign out this device" keeps working
 * across an arbitrary number of rotations.
 *
 * Reuse detection: the superseded hash is retained in `previousTokenHash`.
 * Presenting it means the token was captured and replayed, so the session is
 * destroyed rather than rotated — the attacker and the legitimate holder both
 * lose access, and the user re-authenticates.
 */
export async function refresh(
  rawToken: string,
  context: { userAgent?: string; ipAddress?: string },
): Promise<{ user: PublicUser; tokens: SessionTokens }> {
  const tokenHash = hashToken(rawToken)

  const session = await prisma.session.findFirst({
    where: { OR: [{ refreshTokenHash: tokenHash }, { previousTokenHash: tokenHash }] },
    select: {
      id: true,
      userId: true,
      refreshTokenHash: true,
      previousTokenHash: true,
      rotationCount: true,
      revokedAt: true,
      absoluteExpiresAt: true,
      idleExpiresAt: true,
      user: { select: { status: true, deletedAt: true } },
    },
  })

  if (!session) throw new UnauthorizedError('Invalid refresh token')

  // Replay of an already-rotated token.
  if (session.previousTokenHash === tokenHash) {
    await revokeSessionById(session.id, 'token_reuse')
    logger.warn(
      { sessionId: session.id, userId: session.userId, rotationCount: session.rotationCount },
      'Refresh token reuse detected — session destroyed',
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

  if (!session.user || session.user.deletedAt)
    throw new UnauthorizedError('Account no longer exists')
  if (session.user.status === UserStatus.SUSPENDED)
    throw new ForbiddenError('This account is suspended')
  if (session.user.status === UserStatus.DEACTIVATED)
    throw new ForbiddenError('This account is deactivated')

  const user = await loadPublicUser(session.userId)
  const { raw, hash } = generateRefreshToken()

  // Extend the idle window, but never past the absolute ceiling.
  const nextIdle = new Date(now.getTime() + SESSION_IDLE_TTL_MS)
  const idleExpiresAt = nextIdle < session.absoluteExpiresAt ? nextIdle : session.absoluteExpiresAt

  await prisma.session.update({
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

  const accessToken = signAccessToken({
    userId: user.id,
    sessionId: session.id,
    role: user.role,
  })

  return {
    user,
    tokens: {
      accessToken,
      refreshToken: raw,
      sessionId: session.id,
      refreshExpiresAt: idleExpiresAt,
    },
  }
}

// ─── Session management ──────────────────────────────────────────────────────

async function revokeSessionById(sessionId: string, reason: RevokeReason): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return
  await prisma.session.updateMany({
    where: { refreshTokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'logout' },
  })
}

/**
 * Ends every session for a user.
 * `exceptSessionId` keeps the caller's current session alive, which is what you
 * want for "sign out my other devices".
 */
export async function revokeAllSessions(
  userId: string,
  reason: RevokeReason,
  exceptSessionId?: string,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
  return result.count
}

export async function logoutAll(userId: string, exceptSessionId?: string): Promise<number> {
  return revokeAllSessions(userId, 'logout_all', exceptSessionId)
}

/** The user's own device list, for a "where you're signed in" screen. */
export async function listSessions(userId: string, currentSessionId?: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      lastUsedAt: true,
      absoluteExpiresAt: true,
      idleExpiresAt: true,
    },
    orderBy: { lastUsedAt: 'desc' },
  })
  return sessions.map((s) => ({ ...s, isCurrent: s.id === currentSessionId }))
}

/** Ends one specific session. Users may only end their own. */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  })
  if (!session) throw new NotFoundError('Session')
  await revokeSessionById(sessionId, 'logout')
}

/**
 * Housekeeping: drop rows that can no longer authenticate anything. Safe to run
 * from a cron. Revoked rows are kept for a grace period so support can still
 * answer "why was I signed out?".
 */
export async function pruneExpiredSessions(revokedGraceDays = 30): Promise<number> {
  const now = new Date()
  const graceCutoff = new Date(now.getTime() - revokedGraceDays * 86_400_000)
  const result = await prisma.session.deleteMany({
    where: {
      OR: [{ absoluteExpiresAt: { lt: now } }, { revokedAt: { lt: graceCutoff } }],
    },
  })
  return result.count
}

// ─── Email verification ──────────────────────────────────────────────────────

export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const { raw, hash } = generateOpaqueToken()
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS) },
  })
  await sendMail(verificationEmail(email, raw))
}

export async function resendVerification(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, emailVerifiedAt: true },
  })
  // Silent no-op on unknown or already-verified addresses: this endpoint must
  // not confirm whether an email is registered.
  if (!user || user.emailVerifiedAt) return
  await sendVerificationEmail(user.id, user.email)
}

export async function verifyEmail(rawToken: string): Promise<PublicUser> {
  const stored = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  })

  if (!stored || stored.usedAt)
    throw new BadRequestError('This verification link is invalid or already used')
  if (stored.expiresAt < new Date()) throw new BadRequestError('This verification link has expired')

  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: stored.userId },
      data: { emailVerifiedAt: new Date() },
    }),
    // Promote out of PENDING_VERIFICATION only. updateMany lets us filter on
    // status, so verifying an old link can never resurrect a suspended or
    // deactivated account.
    prisma.user.updateMany({
      where: { id: stored.userId, status: UserStatus.PENDING_VERIFICATION },
      data: { status: UserStatus.ACTIVE },
    }),
  ])

  return loadPublicUser(stored.userId)
}

// ─── Password reset ──────────────────────────────────────────────────────────

export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, deletedAt: true },
  })
  // Always returns success to the caller regardless — see the controller.
  if (!user || user.deletedAt) return

  // Invalidate any outstanding reset tokens so only the newest link works.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  })

  const { raw, hash } = generateOpaqueToken()
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    },
  })

  await sendMail(passwordResetEmail(user.email, raw))
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  })

  if (!stored || stored.usedAt)
    throw new BadRequestError('This reset link is invalid or already used')
  if (stored.expiresAt < new Date()) throw new BadRequestError('This reset link has expired')

  const passwordHash = await hashPassword(newPassword)

  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: stored.userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    }),
    // A password reset ends every existing session. Because auth is stateful,
    // this takes effect immediately rather than at token expiry — which is the
    // whole point when the reset was triggered by a suspected compromise.
    prisma.session.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'password_reset' },
    }),
  ])
}

/**
 * `keepSessionId` lets the caller stay signed in on the device they changed the
 * password from, while every other session is ended.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  })
  if (!user) throw new NotFoundError('User')

  /**
   * A Google-only account has no password to change. Sending it down the
   * verification path would compare against null and report "current password
   * is incorrect", which is both false and a dead end — there is no password
   * they could type that would work.
   *
   * Setting a first password belongs in the reset flow, which proves control of
   * the mailbox. This endpoint requires the existing one by definition.
   */
  if (!user.passwordHash) {
    throw new BadRequestError(
      'This account signs in with Google and has no password. Use "Forgot password" to set one.',
    )
  }

  const valid = await verifyPassword(user.passwordHash, currentPassword)
  if (!valid) throw new UnauthorizedError('Current password is incorrect')

  const passwordHash = await hashPassword(newPassword)

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: 'password_changed' },
    }),
  ])
}

export { loadPublicUser }

/* ─── Google sign-in ────────────────────────────────────────────────────────
 *
 * One entry point for both "sign in" and "sign up". Google does not tell us
 * which the user intended, and asking them to pick the right button before we
 * know whether they have an account is a needless dead end.
 */

/** Which role a brand-new Google account should be created as. */
export type GoogleSignUpRole = typeof Role.CUSTOMER | typeof Role.TESTER

export interface GoogleSignInResult {
  user: PublicUser
  tokens: SessionTokens
  /** True when this call created the account rather than signing one in. */
  created: boolean
}

/**
 * Signs a user in from a verified Google identity, creating or linking as
 * needed.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE LINKING RULE, AND WHY IT IS WHAT IT IS
 *
 * Three cases, resolved in this order:
 *
 *  1. The Google subject is already linked → sign that user in. The `sub` claim
 *     is the join key, never the email: a Google account's address can change,
 *     and matching on it would hand the account to whoever inherits the old
 *     address.
 *
 *  2. No link, but a local account exists with the same VERIFIED address →
 *     attach the identity to it. This is the migration path for legacy users:
 *     someone who has always signed in with a password can press "Continue with
 *     Google" and land in the same account rather than a duplicate.
 *
 *     ⚠ THE `email_verified` CHECK IS LOad-BEARING. Without it, anyone able to
 *     create a Google account claiming an address could take over the local
 *     account holding it. Google only sets the flag for addresses it controls
 *     or has confirmed, so an unverified identity is refused rather than linked.
 *
 *  3. Neither → create a new account in `signUpRole`.
 *
 * A linked account keeps its existing password. Google becomes an additional
 * way in, not a replacement, so nobody is locked out if they later revoke access
 * on Google's side.
 */
export async function signInWithGoogle(
  identity: GoogleIdentity,
  signUpRole: GoogleSignUpRole,
  context: { userAgent?: string; ipAddress?: string },
): Promise<GoogleSignInResult> {
  // ── 1. Known identity ────────────────────────────────────────────────────
  const link = await prisma.oAuthAccount.findUnique({
    where: { provider_providerSubject: { provider: 'google', providerSubject: identity.subject } },
    select: { userId: true, user: { select: { status: true, deletedAt: true } } },
  })

  if (link) {
    if (link.user.deletedAt) throw new UnauthorizedError('This account is no longer active')
    assertUsableStatus(link.user.status)

    await prisma.user.update({
      where: { id: link.userId },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    })
    const user = await loadPublicUser(link.userId)
    return { user, tokens: await openSession(user, context), created: false }
  }

  // ── 2. Existing local account with the same verified address ─────────────
  const existing = await prisma.user.findUnique({
    where: { email: identity.email },
    select: { id: true, status: true, deletedAt: true },
  })

  if (existing) {
    if (!identity.emailVerified) {
      throw new UnauthorizedError(
        'Google has not verified this email address, so it cannot be linked to an existing account.',
      )
    }
    if (existing.deletedAt) throw new UnauthorizedError('This account is no longer active')
    assertUsableStatus(existing.status)

    await prisma.$transaction([
      prisma.oAuthAccount.create({
        data: {
          userId: existing.id,
          provider: 'google',
          providerSubject: identity.subject,
          providerEmail: identity.email,
        },
      }),
      prisma.user.update({
        where: { id: existing.id },
        data: {
          lastLoginAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
          // Google vouching for the address is at least as strong as our own
          // emailed link, so an unverified local account becomes verified and
          // active here rather than being left in limbo.
          ...(existing.status === UserStatus.PENDING_VERIFICATION
            ? { status: UserStatus.ACTIVE, emailVerifiedAt: new Date() }
            : {}),
        },
      }),
    ])

    const user = await loadPublicUser(existing.id)
    return { user, tokens: await openSession(user, context), created: false }
  }

  // ── 3. New account ───────────────────────────────────────────────────────
  const userId = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: identity.email,
        // No password. `login` detects this and directs them back to Google
        // rather than reporting a wrong password for one they never set.
        passwordHash: null,
        role: signUpRole,
        // Google has already proven the address, so there is nothing for our
        // own verification email to add.
        status: identity.emailVerified ? UserStatus.ACTIVE : UserStatus.PENDING_VERIFICATION,
        emailVerifiedAt: identity.emailVerified ? new Date() : null,
        firstName: identity.firstName ?? null,
        lastName: identity.lastName ?? null,
        lastLoginAt: new Date(),
      },
      select: { id: true },
    })

    await tx.oAuthAccount.create({
      data: {
        userId: created.id,
        provider: 'google',
        providerSubject: identity.subject,
        providerEmail: identity.email,
      },
    })

    // Mirrors `register`: a tester signing up opens an application for Admin
    // review (§2.2). A customer's organisation is NOT created here — Google
    // gives us no company name, so that is collected during onboarding.
    if (signUpRole === Role.TESTER) {
      await tx.testerProfile.create({
        data: { userId: created.id, status: TesterStatus.APPLIED },
      })
    }

    return created.id
  })

  const user = await loadPublicUser(userId)
  return { user, tokens: await openSession(user, context), created: true }
}

/** Shared status gate for the Google paths. */
function assertUsableStatus(status: UserStatus): void {
  if (status === UserStatus.SUSPENDED) throw new ForbiddenError('This account is suspended')
  if (status === UserStatus.DEACTIVATED) throw new ForbiddenError('This account is deactivated')
}

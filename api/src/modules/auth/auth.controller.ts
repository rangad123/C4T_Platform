import type { Request, Response } from 'express'
import { param } from '../../lib/http.js'
import { env, isProduction, googleOAuthEnabled } from '../../config/env.js'
import {
  UnauthorizedError,
  ForbiddenError,
  ServiceUnavailableError,
} from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../middleware/authenticate.js'
import { parseDuration } from '../../lib/tokens.js'
import { Role } from '@prisma/client'
import {
  buildAuthorizationUrl,
  createState,
  exchangeCodeForIdentity,
  verifyState,
} from '../../lib/oauth/google.js'
import * as authService from './auth.service.js'
import type { SessionTokens } from './auth.service.js'

const ACCESS_TTL_MS = parseDuration(env.JWT_ACCESS_TTL)

/**
 * Cookies are httpOnly + SameSite=Lax and shared between the Next.js app and
 * this API via COOKIE_DOMAIN (e.g. ".crowd4test.com"). The access token is also
 * returned in the JSON body so non-browser clients can use Authorization headers.
 */
function setAuthCookies(res: Response, tokens: SessionTokens): void {
  const base = {
    httpOnly: true,
    secure: env.COOKIE_SECURE || isProduction,
    sameSite: 'lax' as const,
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  }
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: ACCESS_TTL_MS })
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    // Scoped to the refresh endpoints only, so it is never sent on ordinary
    // calls. Configurable because the path the BROWSER sees differs when the
    // Next.js app proxies this API — see REFRESH_COOKIE_PATH in .env.example.
    path: env.REFRESH_COOKIE_PATH,
    expires: tokens.refreshExpiresAt,
  })
}

function clearAuthCookies(res: Response): void {
  const base = {
    httpOnly: true,
    secure: env.COOKIE_SECURE || isProduction,
    sameSite: 'lax' as const,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  }
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' })
  // The path must match exactly or the browser keeps the cookie.
  res.clearCookie(REFRESH_COOKIE, { ...base, path: env.REFRESH_COOKIE_PATH })
}

function requestContext(req: Request) {
  return { userAgent: req.header('user-agent') ?? undefined, ipAddress: req.ip ?? undefined }
}

export async function register(req: Request, res: Response): Promise<void> {
  const { user, tokens } = await authService.register(req.body, requestContext(req))
  setAuthCookies(res, tokens)
  await recordAudit({ req, action: 'auth.register', entityType: 'User', entityId: user.id })
  res.status(201).json({ data: { user, accessToken: tokens.accessToken } })
}

export async function login(req: Request, res: Response): Promise<void> {
  const { user, tokens } = await authService.login(req.body, requestContext(req))
  setAuthCookies(res, tokens)
  res.json({ data: { user, accessToken: tokens.accessToken } })
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const raw = (req.body?.refreshToken as string | undefined) ?? req.cookies?.[REFRESH_COOKIE]
  if (!raw) throw new UnauthorizedError('No refresh token supplied')

  const { user, tokens } = await authService.refresh(raw, requestContext(req))
  setAuthCookies(res, tokens)
  res.json({ data: { user, accessToken: tokens.accessToken } })
}

export async function logout(req: Request, res: Response): Promise<void> {
  const raw = (req.body?.refreshToken as string | undefined) ?? req.cookies?.[REFRESH_COOKIE]
  await authService.logout(raw)
  clearAuthCookies(res)
  res.json({ data: { success: true } })
}

/**
 * Ends every session. `?keepCurrent=true` spares the calling device, which is
 * the "sign out my other devices" case.
 */
export async function logoutAll(req: Request, res: Response): Promise<void> {
  const keepCurrent = req.query.keepCurrent === 'true'
  const count = await authService.logoutAll(req.user!.id, keepCurrent ? req.sessionId : undefined)
  if (!keepCurrent) clearAuthCookies(res)
  await recordAudit({
    req,
    action: 'auth.logout_all',
    entityType: 'User',
    entityId: req.user!.id,
    after: { sessionsRevoked: count, keptCurrent: keepCurrent },
  })
  res.json({ data: { success: true, sessionsRevoked: count } })
}

/** §2.3/§2.4 — "where you're signed in". */
export async function listSessions(req: Request, res: Response): Promise<void> {
  const sessions = await authService.listSessions(req.user!.id, req.sessionId)
  res.json({ data: sessions })
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const sessionId = param(req, 'id')
  await authService.revokeSession(req.user!.id, sessionId)
  // Ending the session you are currently on is just a logout.
  if (sessionId === req.sessionId) clearAuthCookies(res)
  await recordAudit({
    req,
    action: 'auth.session_revoked',
    entityType: 'Session',
    entityId: sessionId,
  })
  res.status(204).send()
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.loadPublicUser(req.user!.id)
  res.json({ data: { user } })
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  await authService.forgotPassword(req.body.email)
  // Always 200 with the same body, whether or not the address exists — this
  // endpoint must not be an account-enumeration oracle.
  res.json({
    data: {
      message: 'If an account exists for that address, a reset link is on its way.',
    },
  })
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await authService.resetPassword(req.body.token, req.body.password)
  clearAuthCookies(res)
  res.json({ data: { message: 'Password updated. Please sign in with your new password.' } })
}

export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const user = await authService.verifyEmail(req.body.token)
  res.json({ data: { user } })
}

export async function resendVerification(req: Request, res: Response): Promise<void> {
  await authService.resendVerification(req.body.email)
  res.json({
    data: { message: 'If that address needs verifying, a new link is on its way.' },
  })
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  // Keep the caller signed in on this device; end every other session.
  await authService.changePassword(
    req.user!.id,
    req.body.currentPassword,
    req.body.newPassword,
    req.sessionId,
  )
  await recordAudit({
    req,
    action: 'auth.password_changed',
    entityType: 'User',
    entityId: req.user!.id,
  })
  res.json({
    data: { message: 'Password changed. All other sessions have been signed out.' },
  })
}

/* ─── Google OAuth ──────────────────────────────────────────────────────── */

/**
 * Short-lived cookies carrying state across the redirect to Google.
 *
 * Not the session cookies: they are ten minutes long and cleared the moment the
 * flow completes, either way.
 */
const OAUTH_NONCE_COOKIE = 'c4t_oauth_nonce'
const OAUTH_ROLE_COOKIE = 'c4t_oauth_role'

function oauthCookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE || isProduction,
    /**
     * `lax` is required, not incidental. Google's callback is a top-level
     * cross-site GET; `strict` would withhold these cookies on exactly that
     * request and break every sign-in with a state mismatch.
     */
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 10 * 60 * 1000,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  }
}

/** Where each role lands after a Google sign-in. Mirrors web/lib/api/types.ts. */
const ROLE_HOME: Record<string, string> = {
  ADMIN: '/app/admin',
  SUB_ADMIN: '/app/admin',
  CUSTOMER: '/app',
  TESTER: '/app/tester',
  USER: '/app',
}

/**
 * GET /v1/auth/google — start the flow.
 *
 * `?role=customer|tester` says what to create if this turns out to be a new
 * account; `?next=` is the post-login destination. The role rides in a cookie
 * rather than in `state` because `state` is signed but readable, and it is not
 * worth publishing in a URL that lands in Google's request logs.
 */
export function googleStart(req: Request, res: Response): void {
  if (!googleOAuthEnabled) {
    throw new ServiceUnavailableError('Google sign-in is not configured on this deployment')
  }

  const role = req.query.role === 'tester' ? Role.TESTER : Role.CUSTOMER
  const next = typeof req.query.next === 'string' ? req.query.next : undefined

  const { state, nonce } = createState(next)
  res.cookie(OAUTH_NONCE_COOKIE, nonce, oauthCookieOptions())
  res.cookie(OAUTH_ROLE_COOKIE, role, oauthCookieOptions())
  res.redirect(buildAuthorizationUrl(state))
}

/**
 * GET /v1/auth/google/callback — Google sends the user back here.
 *
 * REDIRECTS, NEVER RETURNS JSON. This is a top-level browser navigation, so the
 * only useful outcomes are "signed in, here is your page" and "that failed, here
 * is the sign-in screen with a reason". Failures go to /login with a short
 * `?error=` code the web app maps to a sentence — the same channel the password
 * form already uses.
 */
export async function googleCallback(req: Request, res: Response): Promise<void> {
  const failTo = (reason: string) =>
    res.redirect(`${env.WEB_PUBLIC_URL}/login?error=${encodeURIComponent(reason)}`)

  if (!googleOAuthEnabled) return failTo('google_unavailable')

  const nonce = req.cookies?.[OAUTH_NONCE_COOKIE] as string | undefined
  const roleCookie = req.cookies?.[OAUTH_ROLE_COOKIE] as string | undefined

  // Whatever happens below, this flow is finished with them.
  res.clearCookie(OAUTH_NONCE_COOKIE, oauthCookieOptions())
  res.clearCookie(OAUTH_ROLE_COOKIE, oauthCookieOptions())

  // The user pressed Cancel on Google's consent screen. Not worth an error
  // message — return them to a clean sign-in page.
  if (typeof req.query.error === 'string') {
    return res.redirect(`${env.WEB_PUBLIC_URL}/login`)
  }

  const code = typeof req.query.code === 'string' ? req.query.code : undefined
  const state = typeof req.query.state === 'string' ? req.query.state : undefined
  if (!code || !state) return failTo('google_failed')

  let payload: { next?: string }
  try {
    payload = verifyState(state, nonce)
  } catch {
    return failTo('google_state')
  }

  try {
    const identity = await exchangeCodeForIdentity(code)
    const signUpRole = roleCookie === Role.TESTER ? Role.TESTER : Role.CUSTOMER

    const { user, tokens, created } = await authService.signInWithGoogle(identity, signUpRole, {
      userAgent: req.header('user-agent') ?? undefined,
      ipAddress: req.ip ?? undefined,
    })

    setAuthCookies(res, tokens)
    await recordAudit({
      req,
      action: created ? 'auth.google_register' : 'auth.google_login',
      entityType: 'User',
      entityId: user.id,
    })

    /**
     * `next` was signed into the state, so it cannot have been altered in
     * transit — but it was still user-supplied when the flow began. Only an
     * absolute same-origin path passes; anything else is an open redirect
     * waiting to be used for phishing.
     */
    const target =
      payload.next && payload.next.startsWith('/') && !payload.next.startsWith('//')
        ? payload.next
        : (ROLE_HOME[user.role] ?? '/app')

    res.redirect(`${env.WEB_PUBLIC_URL}${target}`)
  } catch (error) {
    const reason =
      error instanceof ForbiddenError
        ? 'account_unavailable'
        : error instanceof UnauthorizedError
          ? 'google_rejected'
          : 'google_failed'
    return failTo(reason)
  }
}

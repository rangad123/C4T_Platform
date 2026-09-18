import type { Request, Response } from 'express'
import { env, isProduction } from '../../config/env.js'
import { UnauthorizedError } from '../../lib/errors.js'
import { clientAddress } from '../../lib/http.js'
import { recordHrAudit } from '../../lib/hrms/hr-audit.js'
import { HR_ACCESS_TTL_MS } from '../../lib/hrms/hr-tokens.js'
import { HR_ACCESS_COOKIE, HR_REFRESH_COOKIE } from './hr-auth.middleware.js'
import * as hrAuthService from './hr-auth.service.js'
import type { HrSessionTokens } from './hr-auth.service.js'

/**
 * Cookies are httpOnly + host-only — DELIBERATELY no `domain` attribute, so
 * they are only ever sent to hrms.crowd4test.com itself, never to
 * crowd4test.com or any other subdomain. This is the concrete enforcement of
 * "fully separate identity": even on the same box, behind the same nginx,
 * these cookies cannot leak into or be confused with the platform's own.
 *
 * The refresh cookie's path comes from HRMS_REFRESH_COOKIE_PATH, not a
 * literal — see the note on REFRESH_COOKIE_PATH in config/env.ts. Get this
 * wrong and the symptom is silent: the cookie is set, the browser just never
 * sends it back to the refresh route, so every session dies at the 15-minute
 * access-token mark regardless of how long the refresh token is actually
 * valid for. Caught exactly that way in manual testing before this comment
 * existed.
 */
function setHrAuthCookies(res: Response, tokens: HrSessionTokens): void {
  const base = {
    httpOnly: true,
    secure: env.COOKIE_SECURE || isProduction,
    sameSite: 'lax' as const,
    path: '/',
  }
  res.cookie(HR_ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: HR_ACCESS_TTL_MS })
  res.cookie(HR_REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    path: env.HRMS_REFRESH_COOKIE_PATH,
    expires: tokens.refreshExpiresAt,
  })
}

function clearHrAuthCookies(res: Response): void {
  const base = {
    httpOnly: true,
    secure: env.COOKIE_SECURE || isProduction,
    sameSite: 'lax' as const,
  }
  res.clearCookie(HR_ACCESS_COOKIE, { ...base, path: '/' })
  res.clearCookie(HR_REFRESH_COOKIE, { ...base, path: env.HRMS_REFRESH_COOKIE_PATH })
}

function requestContext(req: Request) {
  return { userAgent: req.header('user-agent') ?? undefined, ipAddress: clientAddress(req) }
}

/**
 * No `recordHrAudit` call for an ordinary login — same convention the
 * platform's own auth.controller.ts follows (register/password-change/
 * session-revoke are audited, plain login/logout are not). Two reasons, not
 * one: it would be low-signal noise against the actions that convention
 * reserves the trail for, and it would ALSO be wrong in a way worth stating —
 * `req.hrEmployee` is set by `hrAuthenticate`, which never runs on the login
 * route (there is no session yet to authenticate), so `recordHrAudit` would
 * record `actorId: null` on every entry regardless of who logged in. The
 * `HrSession` row itself — createdAt, ipAddress, userAgent — is the actual
 * "who logged in when" record, exactly as Session is for the platform.
 */
export async function login(req: Request, res: Response): Promise<void> {
  const { employee, tokens } = await hrAuthService.login(req.body, requestContext(req))
  setHrAuthCookies(res, tokens)
  res.json({ data: { employee, accessToken: tokens.accessToken } })
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const cookie = req.cookies?.[HR_REFRESH_COOKIE] as string | undefined
  const body = req.body?.refreshToken as string | undefined
  const raw = cookie ?? body
  if (!raw) throw new UnauthorizedError('No refresh token supplied')

  const { employee, tokens } = await hrAuthService.refresh(raw, requestContext(req))
  setHrAuthCookies(res, tokens)
  res.json({ data: { employee, accessToken: tokens.accessToken } })
}

export async function logout(req: Request, res: Response): Promise<void> {
  const raw = (req.cookies?.[HR_REFRESH_COOKIE] as string | undefined) ?? req.body?.refreshToken
  await hrAuthService.logout(raw)
  clearHrAuthCookies(res)
  res.status(204).end()
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  if (!req.hrEmployee) throw new UnauthorizedError()
  await hrAuthService.changePassword(
    req.hrEmployee.id,
    req.body.currentPassword,
    req.body.newPassword,
    req.hrSessionId,
  )
  await recordHrAudit({
    req,
    action: 'hr.auth.password_changed',
    entityType: 'HrEmployee',
    entityId: req.hrEmployee.id,
  })
  res.status(204).end()
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.hrEmployee) throw new UnauthorizedError()
  const employee = await hrAuthService.loadPublicEmployee(req.hrEmployee.id)
  res.json({ data: employee })
}

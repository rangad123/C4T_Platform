import type { Request } from 'express'
import { BadRequestError } from './errors.js'

/**
 * Express 5 types `req.params` values as `string | string[]`, because a path
 * pattern can bind a parameter more than once. Every route here binds each
 * parameter exactly once and validates it with Zod first, so this helper
 * narrows to `string` and fails loudly if that assumption is ever broken.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError(`Missing or invalid route parameter: ${name}`)
  }
  return value
}

/**
 * The address to attribute a request to, for rate-limiting and for
 * account-owner-facing display (an "Active sessions" row, an abuse-triage
 * column) — never for authorisation.
 *
 * `req.ip` is this API's own web server for anything reached through a
 * relayed server-to-server call, which is most of this app's traffic by
 * design (see `web/src/lib/api/server.ts`'s doc comment: the browser never
 * talks to this service directly). `x-c4t-client-ip` is what the web tier
 * sends instead — see `web/src/lib/auth/request-context.ts` for the callers
 * that set it and why. Trusted only because the header can only be set by
 * that server's own outbound calls, never by a public caller reaching this
 * API through the one path that is actually exposed to the internet.
 */
export function clientAddress(req: Request): string {
  const forwarded = req.get('x-c4t-client-ip')?.trim()
  if (forwarded) return forwarded.slice(0, 45)
  return req.ip ?? 'unknown'
}

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
 * that set it and why.
 *
 * The header is believed only from the web server's own calls, which is NOT
 * the same as "anything on loopback": nginx also exposes this API publicly at
 * `/api/v1` and proxies it to the same loopback port, so a public caller's
 * request arrives from 127.0.0.1 too. What tells them apart is that nginx adds
 * `X-Forwarded-For` to everything it forwards (which is also what makes
 * `trust proxy` give `req.ip` the visitor's address), while the web server's
 * own `fetch` to `API_ORIGIN` never sends it. A public caller cannot remove a
 * header nginx sets, so a request carrying any forwarding header is treated as
 * public and keyed on `req.ip`, whatever `x-c4t-client-ip` says.
 */
export function clientAddress(req: Request): string {
  const forwarded = req.get('x-c4t-client-ip')?.trim()
  if (forwarded && fromWebServer(req)) return forwarded.slice(0, 45)
  return req.ip ?? 'unknown'
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** A direct loopback call that did not pass through a proxy. See `clientAddress`. */
function fromWebServer(req: Request): boolean {
  const peer = req.socket.remoteAddress
  if (!peer || !LOOPBACK.has(peer)) return false
  return (
    req.get('x-forwarded-for') === undefined &&
    req.get('x-real-ip') === undefined &&
    req.get('forwarded') === undefined
  )
}

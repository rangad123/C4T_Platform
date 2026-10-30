import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { NotFoundError, UnauthorizedError } from '../lib/errors.js'

/**
 * Shortest service token accepted. A shorter value is treated as unset rather
 * than refused at boot: one integration being misconfigured must not take the
 * whole API down (see the PUBLIC_ASSETS_BASE_URL note in config/env.ts).
 */
export const MIN_SERVICE_TOKEN_LENGTH = 32

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Gate for server-to-server routes: the caller presents a shared secret as
 * `Authorization: Bearer <token>` and nothing else counts. A user's session
 * cookie or access token is never consulted, so signing in to crowd4test.com
 * does not reach these routes.
 *
 * With no token configured the routes answer 404, exactly as the terminal
 * not-found handler would, so an unconfigured deployment does not advertise
 * them.
 *
 * Both sides are hashed before `timingSafeEqual`, which needs equal lengths;
 * comparing digests keeps the comparison constant-time without leaking the
 * secret's length.
 */
export function requireServiceToken(expected: string | undefined) {
  const configured =
    expected && expected.length >= MIN_SERVICE_TOKEN_LENGTH ? digest(expected) : null

  return function serviceTokenGuard(req: Request, res: Response, next: NextFunction): void {
    if (!configured) throw new NotFoundError(`Route ${req.method} ${req.baseUrl}${req.path}`)

    const header = req.header('authorization')
    const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!presented || !timingSafeEqual(digest(presented), configured)) {
      throw new UnauthorizedError('A valid service token is required')
    }

    res.setHeader('cache-control', 'no-store')
    next()
  }
}

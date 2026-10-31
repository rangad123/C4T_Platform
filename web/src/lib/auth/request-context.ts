import { headers } from 'next/headers'

/**
 * The two headers every relayed call to `/v1/auth/*` needs to add to its own
 * outbound `fetch`, so the API sees the actual visitor instead of this server.
 *
 * ── The bug this exists to stop
 *
 * Every auth endpoint is reached through a server-to-server call — this app's
 * whole design keeps the browser from ever talking to the API directly (see
 * `lib/api/server.ts`'s doc comment) — so on the API side `req.ip` is always
 * this web server's own loopback address and `req.header('user-agent')` is
 * whatever Node's own `fetch` sends by default, never the visitor's.
 *
 * That silently broke two things at once, discovered together because they
 * share the one root cause:
 *
 *  - `authIpLimiter` (`api/src/middleware/rateLimit.ts`) counts requests per
 *    `req.ip`. With every visitor sharing one address, its budget is shared
 *    by the whole platform, not per person — verified directly: 20 DIFFERENT
 *    people each attempting to log in once, no repeats, hit the ceiling
 *    together and the 21st got a 429, unrelated to anything they did.
 *  - "Active sessions" (`Session.userAgent` / `.ipAddress`, set in
 *    `auth.controller.ts`'s `requestContext`) showed every session, for
 *    every account, as `Unknown device / node / 127.0.0.1` — the one place
 *    on the platform meant to let someone recognise their own devices and
 *    catch a stranger's could never show either.
 *
 * ── Why `user-agent` rides as itself but the IP needs a custom header
 *
 * There is no ambiguity in forwarding the real `User-Agent` string AS the
 * `user-agent` header on this server's own outbound call — the API just
 * reads `req.header('user-agent')` and gets the true value, no server-side
 * change needed for that half.
 *
 * `req.ip` cannot be overridden the same way; Express derives it from the
 * TCP connection (or, with `trust proxy`, a real `X-Forwarded-For` chain),
 * neither of which this relayed call is part of. `x-c4t-client-ip` is a
 * value the API trusts ONLY because the sole caller able to reach it is this
 * server's own outbound traffic — nothing on the public internet can set it
 * on a request the API treats as authoritative. It is read for rate-limiting
 * and for the account-owner-facing session list, never for authorisation.
 */
export function authHeaders(incoming: Headers): Record<string, string> {
  const out: Record<string, string> = {}

  const userAgent = incoming.get('user-agent')
  if (userAgent) out['user-agent'] = userAgent

  const visitor = visitorAddress(incoming)
  if (visitor) out['x-c4t-client-ip'] = visitor

  return out
}

/**
 * The visitor's address as nginx saw it: the LAST entry of `X-Forwarded-For`.
 *
 * nginx appends the address of whoever connected to it, and that is the only
 * entry anyone can vouch for. Everything before it came from the visitor's own
 * request and can say anything, so taking the first entry let any caller pick
 * the rate-limit bucket the API would count them in. Next.js adds the header
 * only when nginx did not, so the last entry is never Next's own.
 */
export function visitorAddress(incoming: Headers): string | undefined {
  const chain = incoming.get('x-forwarded-for')?.split(',')
  const last = chain?.[chain.length - 1]?.trim()
  if (!last) return undefined
  return last
}

/** The Server Action / Route Handler convenience form — reads the incoming request's headers itself. */
export async function currentAuthHeaders(): Promise<Record<string, string>> {
  return authHeaders(await headers())
}

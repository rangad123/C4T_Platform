/**
 * A minimal `Set-Cookie` parser, and the rule for re-issuing the API's auth
 * cookies on this origin.
 *
 * Framework-free on purpose: the same parse is needed by the cookie bridge
 * (which writes through `next/headers`) and by Proxy (which writes onto a
 * `NextResponse`), and those two cannot import each other's APIs.
 */

export interface ParsedCookie {
  name: string
  value: string
  path?: string
  maxAge?: number
  expires?: Date
  sameSite?: 'lax' | 'strict' | 'none'
  secure?: boolean
  httpOnly?: boolean
}

/**
 * Tolerant of the subset the API sends:
 *   name=value; Path=/; Max-Age=...; Expires=...; HttpOnly; Secure; SameSite=Lax
 *
 * It does NOT decode `Expires=` timestamps in the locale-dependent format the
 * spec allows — the API always emits `Max-Age` for the access cookie, so that
 * is read and `Expires` ignored.
 *
 * `Domain` is parsed but deliberately never applied by callers — see
 * `authCookieOptions` below.
 */
export function parseSetCookie(input: string): ParsedCookie | null {
  const parts = input
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return null

  const [namePair, ...attrs] = parts
  if (!namePair) return null

  const eq = namePair.indexOf('=')
  if (eq <= 0) return null

  const name = namePair.slice(0, eq).trim()
  const value = namePair.slice(eq + 1).trim()
  if (!name) return null

  const out: ParsedCookie = { name, value }
  for (const attr of attrs) {
    const i = attr.indexOf('=')
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase()
    const val = i < 0 ? '' : attr.slice(i + 1).trim()
    if (!key) continue
    switch (key) {
      case 'path':
        out.path = val || '/'
        break
      case 'max-age': {
        const n = Number(val)
        if (Number.isFinite(n)) out.maxAge = Math.max(0, Math.floor(n))
        break
      }
      case 'samesite':
        if (val === 'Lax' || val === 'lax') out.sameSite = 'lax'
        else if (val === 'Strict' || val === 'strict') out.sameSite = 'strict'
        else if (val === 'None' || val === 'none') out.sameSite = 'none'
        break
      case 'secure':
        out.secure = true
        break
      case 'httponly':
        out.httpOnly = true
        break
      // Expires / Domain are read past deliberately — see the note above and
      // `authCookieOptions` below.
    }
  }
  return out
}

/**
 * The options to store one of the API's auth cookies under, on THIS origin.
 *
 * ── PATH AND DOMAIN ARE DELIBERATELY DISCARDED
 *
 * The API scopes its refresh cookie to `Path=/api/v1/auth` and (in this
 * deployment) `Domain=.crowd4test.com`. Both are correct when the BROWSER
 * talks to the API directly. Both are wrong here, because these cookies are
 * being stored against the Next.js origin:
 *
 *  - No `/api/v1/auth` path exists on this origin, so a refresh cookie kept
 *    at that path would never be sent back on any request this app serves —
 *    `logoutAction` could not read it, and neither could a refresh.
 *  - The Domain would not bind on `localhost` at all, so nothing would
 *    persist in development.
 *
 * Both cookies are therefore stored host-bound at `/`. They stay `httpOnly`,
 * so page JavaScript still cannot read them; only code running on the server
 * ever sees a value. Next's Server Actions carry their own CSRF origin check,
 * which is what the narrow path was buying on the API side.
 */
export function authCookieOptions(parsed: ParsedCookie, isProduction: boolean) {
  return {
    name: parsed.name,
    value: parsed.value,
    httpOnly: parsed.httpOnly ?? true,
    secure: parsed.secure ?? isProduction,
    sameSite: parsed.sameSite ?? ('lax' as const),
    path: '/',
    ...(typeof parsed.maxAge === 'number' ? { maxAge: parsed.maxAge } : {}),
  }
}

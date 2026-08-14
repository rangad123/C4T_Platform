import { cookies } from 'next/headers'
import { env } from '@/lib/env'

/**
 * Cookie bridging for Server Actions that call the auth API.
 *
 * The browser fetches `/api/v1/*` via the Next.js rewrite proxy and receives
 * `Set-Cookie` headers through that proxy. A Server Action cannot use that
 * path — it runs on the Next.js server, not in the browser — so it must call
 * the API directly at `env.API_ORIGIN`. The response still carries
 * `Set-Cookie` headers, but the browser never sees them because it isn't the
 * recipient of this request.
 *
 * The fix is to copy each `Set-Cookie` from the API response onto the Next.js
 * response via `cookies().set()`. The browser then receives them as if the
 * form had posted directly to `/api/v1/auth/login`.
 *
 * Cookies are httpOnly + SameSite=Lax; options mirror what the API sends so
 * the browser's resulting cookie jar is identical regardless of which path set
 * them. Domain is omitted in dev (no `COOKIE_DOMAIN`), matching the API, so
 * the cookie binds to the host that served it.
 *
 * ── Why parse by hand rather than reach for a package
 *
 * A spec-compliant `Set-Cookie` parser is ~30 lines of code. Pulling in
 * `set-cookie-parser` for that would be ceremony for one helper used in two
 * places (login and reset, eventually). If we ever need to parse cookies on
 * the request side too, swap this for the package.
 */

interface ParsedCookie {
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
 * Minimal `Set-Cookie` parser. Tolerant of the subset the API sends:
 *   name=value; Path=/; Max-Age=...; Expires=...; HttpOnly; Secure; SameSite=Lax
 *
 * It does NOT attempt to decode `Expires=` timestamps in the locale-dependent
 * format that the spec allows — the API always emits `Max-Age`, so we read
 * that and ignore `Expires` if present. The full Date form is round-tripped
 * from the cookie when the browser sees it; we just need Max-Age.
 */
function parseSetCookie(input: string): ParsedCookie | null {
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
      // Expires / Domain are ignored — see the note above on Max-Age, and
      // the cookie is host-bound in dev so we never want a Domain attribute.
    }
  }
  return out
}

export async function bridgeApiCookies(response: Response): Promise<void> {
  // `getSetCookie()` is the WHATWG-spec accessor that returns every Set-Cookie
  // header separately — unlike `headers.get('set-cookie')`, which collapses
  // them into one comma-joined string and corrupts values that contain commas.
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []

  if (setCookies.length === 0) return

  const cookieStore = await cookies()
  for (const raw of setCookies) {
    const parsed = parseSetCookie(raw)
    if (!parsed) continue

    cookieStore.set({
      name: parsed.name,
      value: parsed.value,
      httpOnly: parsed.httpOnly ?? true,
      secure: parsed.secure ?? env.NEXT_PUBLIC_ENVIRONMENT === 'production',
      sameSite: parsed.sameSite ?? 'lax',
      /**
       * THE API'S PATH IS DELIBERATELY DISCARDED HERE.
       *
       * The API scopes its refresh cookie to `Path=/v1/auth`, which is correct
       * when the BROWSER talks to the API — either directly or through the
       * `/api/v1/*` rewrite (see the REFRESH_COOKIE_PATH note in web/.env).
       * It is wrong here, because these cookies are being set on the NEXT.JS
       * origin, where no `/v1/auth` path exists. A refresh cookie stored at
       * that path would never be sent back on any request this app serves —
       * so `logoutAction` could not read it, and the session row on the API
       * would survive a sign-out.
       *
       * Both cookies are therefore stored at `/`. They stay `httpOnly`, so
       * page JavaScript still cannot read them, and only Server Actions and
       * Server Components (which run on the server) ever see the value.
       * Next's Server Actions carry their own CSRF origin check, which is
       * what the narrow path was buying on the API side.
       */
      path: '/',
      ...(typeof parsed.maxAge === 'number' ? { maxAge: parsed.maxAge } : {}),
    })
  }
}

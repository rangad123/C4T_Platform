import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import { authCookieOptions, parseSetCookie } from '@/lib/auth/set-cookie'

/**
 * Cookie bridging for Server Actions that call the auth API.
 *
 * A Server Action runs on the Next.js server, not in the browser, so it calls
 * the API directly at `env.API_ORIGIN`. The response still carries
 * `Set-Cookie` headers, but the browser never sees them because it isn't the
 * recipient of that request.
 *
 * The fix is to copy each `Set-Cookie` from the API response onto the Next.js
 * response via `cookies().set()`. The browser then receives them as if the
 * form had posted to the API itself.
 *
 * The parsing, and the rule for which cookie attributes survive the hop, live
 * in `set-cookie.ts` — shared with `proxy.ts`, which does the same thing at
 * navigation time onto a `NextResponse`.
 */

export async function bridgeApiCookies(response: Response): Promise<void> {
  // `getSetCookie()` is the WHATWG-spec accessor that returns every Set-Cookie
  // header separately — unlike `headers.get('set-cookie')`, which collapses
  // them into one comma-joined string and corrupts values containing commas.
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []

  await applySetCookies(setCookies)
}

/**
 * The half of `bridgeApiCookies` that does not need the `Response` object.
 *
 * Separate because the refresh path shares ONE API call between concurrent
 * requests but must still set cookies on each of their responses
 * individually — so it holds the raw header strings and applies them more
 * than once, rather than holding a `Response` only the first caller could
 * read.
 */
export async function applySetCookies(setCookies: readonly string[]): Promise<void> {
  if (setCookies.length === 0) return

  const cookieStore = await cookies()
  for (const raw of setCookies) {
    const parsed = parseSetCookie(raw)
    if (!parsed) continue
    cookieStore.set(authCookieOptions(parsed, env.NEXT_PUBLIC_ENVIRONMENT === 'production'))
  }
}

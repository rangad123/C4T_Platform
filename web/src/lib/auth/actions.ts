'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { ROLE_HOME, type Role } from '@/lib/api/types'
import { safeNext } from '@/lib/safe-redirect'
import { formString, formTrimmed } from '@/lib/form-data'
import { bridgeApiCookies } from '@/lib/auth/cookie-bridge'

/**
 * Cookie bridging for Server Actions that call the auth API.
 *
 * The browser fetches `/api/v1/*` via the Next.js rewrite proxy and receives
 * `Set-Cookie` headers through that proxy. A Server Action cannot use that
 * path â€” it runs on the Next.js server, not in the browser â€” so it must call
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
 * â”€â”€ Why parse by hand rather than reach for a package
 *
 * A spec-compliant `Set-Cookie` parser is ~30 lines of code. Pulling in
 * `set-cookie-parser` for that would be ceremony for one helper used in two
 * places (login and reset, eventually). If we ever need to parse cookies on
 * the request side too, swap this for the package.
 */

/**
 * Server Action: sign in with email + password.
 *
 * Posts to the API, bridges cookies onto the Next.js response, then redirects
 * to `?next=` (if it passes the same-origin check) or the role's home. On
 * failure, redirects back to /login with the email preserved and a short
 * error code that the page maps to a sentence.
 *
 * The page renders a Server Component form bound to this action â€” no client
 * state, no `useFormState`. The query-param echo is the entire feedback
 * channel, which keeps the form a Server Component (CLAUDE.md spirit, applied
 * to the admin surface too).
 */
export async function loginAction(formData: FormData): Promise<void> {
  const email = formTrimmed(formData, 'email')
  const password = formString(formData, 'password')
  const next = formString(formData, 'next')

  if (!email || !password) {
    redirect(
      `/login?error=missing${next ? `&next=${encodeURIComponent(next)}` : ''}&email=${encodeURIComponent(email)}`,
    )
  }

  let response: Response
  try {
    response = await fetch(new URL('/v1/auth/login', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    })
  } catch {
    redirect(
      `/login?error=network${next ? `&next=${encodeURIComponent(next)}` : ''}&email=${encodeURIComponent(email)}`,
    )
  }

  if (!response.ok) {
    // Map the API's documented error codes to the page's known reason codes.
    // The API returns a single `UNAUTHORIZED` for every wrong-credential
    // scenario (unknown email, wrong password, suspended account, deleted
    // account) â€” by design, so the page cannot leak which one matched. Each
    // of those maps to a known code here so the form shows a meaningful
    // sentence rather than the generic fallback.
    let code = 'invalid'
    try {
      const body = (await response.json()) as { error?: { code?: string } }
      if (body?.error?.code) {
        const apiCode = body.error.code.toLowerCase()
        if (apiCode === 'unauthorized') {
          code = 'invalid_credentials'
        } else {
          code = apiCode
        }
      }
    } catch {
      // Body wasn't JSON â€” keep the generic code.
    }
    redirect(
      `/login?error=${encodeURIComponent(code)}${next ? `&next=${encodeURIComponent(next)}` : ''}&email=${encodeURIComponent(email)}`,
    )
  }

  await bridgeApiCookies(response)

  const body = (await response.json()) as {
    data?: { user?: { role?: Role } }
  }
  const role = body?.data?.user?.role
  const home = role ? ROLE_HOME[role] : '/app'
  const target = safeNext(next) ?? home
  redirect(target)
}

/**
 * Server Action: end the current session.
 *
 * Posts to the API (which clears its server-side session row AND expires its
 * cookies), then clears the bridged cookies on the Next.js response and
 * redirects to /login.
 */
export async function logoutAction(): Promise<void> {
  // Read the refresh cookie so the API can destroy the session row even if
  // the access cookie has already expired.
  const cookieStore = await cookies()
  const refreshCookie = cookieStore.get('c4t_refresh')
  const cookieHeader = cookieStore.toString()

  try {
    await fetch(new URL('/v1/auth/logout', env.API_ORIGIN), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify(refreshCookie?.value ? { refreshToken: refreshCookie.value } : {}),
      cache: 'no-store',
    })
  } catch {
    // Even if the API is unreachable we still want to clear local cookies and
    // send the visitor to the sign-in screen â€” being stuck on a logged-in page
    // is the worse failure mode.
  }

  cookieStore.delete('c4t_access')
  cookieStore.delete('c4t_refresh')
  redirect('/login')
}

/**
 * NOTHING ELSE MAY BE EXPORTED FROM THIS FILE.
 *
 * A `'use server'` module is an RPC boundary: every export becomes a callable
 * server action, so Next requires all of them to be async functions. This file
 * briefly re-exported the `ApiError` class as a convenience, which silently
 * invalidated the whole module â€” the two real actions stopped being
 * registered, and every form submission failed at runtime with
 * `UnrecognizedActionError: Server Action "â€¦" was not found on the server`.
 *
 * The error names an opaque action id and points at the calling form, not at
 * the offending export, so it reads like a stale-build problem and survives a
 * restart. Import `ApiError` from `@/lib/api/types` directly instead.
 */

/**
 * Server Action: request a password-reset email.
 *
 * Posts to `POST /v1/auth/forgot-password` and redirects back to the same page
 * with a notice flag. The API always returns the same 200 regardless of
 * whether the email matched an account â€” this endpoint must not be an
 * account-enumeration oracle.
 */
export async function forgotPasswordAction(formData: FormData): Promise<void> {
  const email = formTrimmed(formData, 'email')

  if (!email) {
    redirect('/forgot-password?error=missing')
  }

    try {
    await fetch(new URL('/v1/auth/forgot-password', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
      cache: 'no-store',
    })
  } catch {
    // Network or server unreachable — the redirect below still runs.
  }

  // Same 200 either way, per the API. Redirect to the success state —
  // the generic message tells the user to check their inbox regardless.
  redirect(`/forgot-password?email=${encodeURIComponent(email)}`)
}

/**
 * Server Action: complete a password reset from the emailed token.
 *
 * Posts to `POST /v1/auth/reset-password` and either redirects back with an
 * error flag or to /login on success. The form's hidden input is the token;
 * the password is the new one the user typed.
 */
export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = formTrimmed(formData, 'token')
  const password = formTrimmed(formData, 'password')
  const confirmPassword = formTrimmed(formData, 'confirmPassword')

  if (!token || !password) {
    redirect(`/reset-password?error=missing${token ? '' : '&token=missing'}`)
  }

  if (confirmPassword !== undefined && password !== confirmPassword) {
    redirect(`/reset-password?token=${encodeURIComponent(token)}&error=password_mismatch`)
  }

  let response: Response
  try {
    response = await fetch(new URL('/v1/auth/reset-password', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password }),
      cache: 'no-store',
    })
  } catch {
    redirect(`/reset-password?token=${encodeURIComponent(token)}&error=network`)
  }

  if (!response.ok) {
    // The API returns a stable code for expired/used/invalid tokens (see
    // resetPasswordSchema / resetPassword in the API's auth module).
    let code = 'failed'
    try {
      const body = (await response.json()) as { error?: { code?: string } }
      const apiCode = body?.error?.code?.toLowerCase()
      if (apiCode === 'bad_request') code = 'expired'
    } catch {
      // Body wasn't JSON — keep the generic code.
    }
    redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${code}`)
  }

  redirect('/login?notice=password_reset')
}

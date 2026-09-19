'use server'

import { cookies } from 'next/headers'
import { hrExternalRedirect } from './hr-external-redirect'
import { env } from '@/lib/env'
import { safeNext } from '@/lib/safe-redirect'
import { formString, formTrimmed } from '@/lib/form-data'
import { bridgeApiCookies } from '@/lib/auth/cookie-bridge'
import { currentAuthHeaders } from '@/lib/auth/request-context'
import { HR_ROLE_HOME, type PublicHrEmployee } from './hr-types'

/**
 * HRMS's own login/logout Server Actions — structural copy of
 * `lib/auth/actions.ts`'s `loginAction`/`logoutAction`, pointed at
 * `/v1/hrms/auth/*` instead of `/v1/auth/*`.
 *
 * Everything these lean on is already generic and reused as-is:
 * `bridgeApiCookies` copies whatever `Set-Cookie` headers the API sent
 * without knowing their names; `currentAuthHeaders` forwards the real
 * visitor IP/user-agent via the same `x-c4t-client-ip` convention the
 * platform uses, which `clientAddress()` on the API reads regardless of
 * which auth stack called it; `safeNext`/`formString`/`formTrimmed` are pure
 * helpers with no platform coupling.
 *
 * NOT reusing `loginAction`/`logoutAction` themselves: those redirect via
 * `ROLE_HOME`/the platform's `Role` union and clear `c4t_*` cookies, none of
 * which apply here.
 */

/**
 * What the sign-in form renders after a failed attempt.
 *
 * A FAILED sign-in does not redirect anywhere — it returns, and the form
 * shows the message in place. That is not just tidier than bouncing through
 * `/login?error=...`, it is the only thing that actually works here.
 *
 * HRMS is one Next app behind a host-based rewrite: `proxy.ts` turns
 * `hrms.crowd4test.com/login` into `app/hrms/login` on the server. Every real
 * request goes through that correctly. What it cannot reach is Next's client
 * router, which resolves a redirect target against the filesystem and knows
 * nothing about the rewrite — and a second, real `/login` page exists at the
 * marketing site's top level. That one won, so a wrong password silently
 * replaced the sign-in screen with the marketing homepage and its own login
 * dialog: right address bar, wrong page, no error shown. An absolute URL does
 * not help; Next normalises a same-origin one back to a client transition.
 *
 * Not navigating at all sidesteps the whole problem, and stops putting the
 * address someone just typed into their URL bar and browser history.
 */
export interface HrLoginState {
  /** A code from ERROR_MESSAGES in the form, or undefined before first submit. */
  error?: string
  /** Echoed back so a failed attempt does not clear what was typed. */
  email?: string
}

export async function hrLoginAction(
  _previous: HrLoginState,
  formData: FormData,
): Promise<HrLoginState> {
  const email = formTrimmed(formData, 'email')
  const password = formString(formData, 'password')
  const next = formString(formData, 'next')

  if (!email || !password) return { error: 'missing', email }

  let response: Response
  try {
    response = await fetch(new URL('/v1/hrms/auth/login', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await currentAuthHeaders()) },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    })
  } catch {
    return { error: 'network', email }
  }

  if (!response.ok) {
    // The API returns a single UNAUTHORIZED for every wrong-credential case
    // (unknown email, wrong password, locked account) — see hr-auth.service.ts.
    let code = 'invalid'
    try {
      const body = (await response.json()) as { error?: { code?: string } }
      if (body?.error?.code) {
        const apiCode = body.error.code.toLowerCase()
        code = apiCode === 'unauthorized' ? 'invalid_credentials' : apiCode
      }
    } catch {
      // Body wasn't JSON — keep the generic code.
    }
    return { error: code, email }
  }

  await bridgeApiCookies(response)

  // login()'s envelope is { data: { employee, accessToken } } — NOT the same
  // shape as /me's { data: employee }. Reading `data.role` here silently read
  // a field that never existed and always fell back to `/login`; caught by
  // reconstructing the real response from a direct API call rather than by
  // any type error, since both shapes satisfy an under-specified cast.
  const body = (await response.json()) as { data?: { employee?: PublicHrEmployee } }
  const role = body?.data?.employee?.role
  const target = safeNext(next) ?? (role ? HR_ROLE_HOME[role] : null)
  /*
    Success DOES navigate — there is somewhere to go. `/admin` and `/employee`
    are HRMS-only addresses, so unlike `/login` they collide with nothing at
    the marketing site's top level and resolve correctly either way. Going
    through the helper regardless, because the session cookies were just set
    on this response and a fresh document is what reliably picks them up
    rather than carrying pre-sign-in router state across the boundary.
  */
  hrExternalRedirect(target ?? '/login')
}

export async function hrLogoutAction(): Promise<void> {
  const cookieStore = await cookies()
  const refreshCookie = cookieStore.get('hrms_refresh')
  const cookieHeader = cookieStore.toString()

  try {
    await fetch(new URL('/v1/hrms/auth/logout', env.API_ORIGIN), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify(refreshCookie?.value ? { refreshToken: refreshCookie.value } : {}),
      cache: 'no-store',
    })
  } catch {
    // Being stuck on a signed-in page is worse than a failed server-side
    // logout call — clear local cookies and send the visitor away regardless.
  }

  cookieStore.delete('hrms_access')
  cookieStore.delete('hrms_refresh')
  /*
    Deliberately does NOT redirect. `/login` is one of the three paths that
    also exist at the marketing site's top level, and a redirect from a Server
    Action is resolved by Next's client router, which picks that one — so
    signing out landed on the marketing homepage. `HrSignOutButton` sends the
    browser to `/login` itself once this returns, which is a real navigation
    through the server and therefore through the hostname rewrite.
  */
}

/**
 * NOTHING ELSE MAY BE EXPORTED FROM THIS FILE — see the identical warning in
 * lib/auth/actions.ts. A `'use server'` module is an RPC boundary; every
 * export must be an async function, and one that isn't silently deregisters
 * every action in the file rather than failing to compile.
 */

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
 * `/login` exists at HRMS's own address AND, separately, as the marketing
 * site's own top-level page — see `hrExternalRedirect`'s own comment for why
 * that collision means every redirect back to it must force a real browser
 * navigation rather than let the client router resolve it.
 */
function hrAuthRedirect(href: string): never {
  hrExternalRedirect(href)
}

export async function hrLoginAction(formData: FormData): Promise<void> {
  const email = formTrimmed(formData, 'email')
  const password = formString(formData, 'password')
  const next = formString(formData, 'next')

  if (!email || !password) {
    hrAuthRedirect(
      `/login?error=missing${next ? `&next=${encodeURIComponent(next)}` : ''}&email=${encodeURIComponent(email)}`,
    )
  }

  let response: Response
  try {
    response = await fetch(new URL('/v1/hrms/auth/login', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await currentAuthHeaders()) },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    })
  } catch {
    hrAuthRedirect(
      `/login?error=network${next ? `&next=${encodeURIComponent(next)}` : ''}&email=${encodeURIComponent(email)}`,
    )
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
    hrAuthRedirect(
      `/login?error=${encodeURIComponent(code)}${next ? `&next=${encodeURIComponent(next)}` : ''}&email=${encodeURIComponent(email)}`,
    )
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
    A full browser navigation rather than a client-side one, and not only for
    consistency with the failure paths above: the session cookies were just
    set on this response, and a fresh document is the one thing guaranteed to
    pick them up without carrying any pre-sign-in router state across the
    boundary. `/login` is the fallback when a response that otherwise looked
    successful carried no role.
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
  hrExternalRedirect('/login')
}

/**
 * NOTHING ELSE MAY BE EXPORTED FROM THIS FILE — see the identical warning in
 * lib/auth/actions.ts. A `'use server'` module is an RPC boundary; every
 * export must be an async function, and one that isn't silently deregisters
 * every action in the file rather than failing to compile.
 */

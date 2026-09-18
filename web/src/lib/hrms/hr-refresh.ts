import 'server-only'
import { cookies } from 'next/headers'
import { applySetCookies } from '@/lib/auth/cookie-bridge'
import { spendHrRefreshToken } from './hr-refresh-core'
import { currentAuthHeaders } from '@/lib/auth/request-context'

/**
 * Refreshes the HR session from a Server Action, persisting the rotated
 * cookies — the HRMS counterpart to `lib/auth/refresh.ts`'s `attemptRefresh`.
 * See that file for why this only works from a Server Action/Route Handler
 * and never from a Server Component render.
 */
export async function attemptHrRefresh(): Promise<boolean> {
  const cookieStore = await cookies()
  const refreshToken = cookieStore.get('hrms_refresh')?.value
  if (!refreshToken) return false

  const setCookies = await spendHrRefreshToken(
    refreshToken,
    cookieStore.toString(),
    await currentAuthHeaders(),
  )
  if (!setCookies || setCookies.length === 0) return false

  await applySetCookies(setCookies)
  return true
}

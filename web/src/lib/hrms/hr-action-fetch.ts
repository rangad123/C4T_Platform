import 'server-only'
import { serverFetch, type ServerRequestOptions } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { attemptHrRefresh } from './hr-refresh'

/**
 * `serverFetch` for HRMS Server Actions, with one refresh-and-retry on an
 * expired access token — the HRMS counterpart to `lib/api/action-fetch.ts`.
 * See that file for the full reasoning; nothing here differs except calling
 * `attemptHrRefresh` instead of the platform's `attemptRefresh`.
 */
export async function hrActionFetch<T>(
  path: string,
  options: ServerRequestOptions = {},
): Promise<T> {
  try {
    return await serverFetch<T>(path, options)
  } catch (error) {
    if (!(error instanceof ApiError) || !error.isRetryableAuthFailure) throw error
    if (!(await attemptHrRefresh())) throw error
    return await serverFetch<T>(path, options)
  }
}

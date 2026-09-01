import 'server-only'
import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import { ApiError, type ApiFailure, type ApiSuccess, type PageMeta } from './types'

/**
 * Server-side API access for Server Components, Route Handlers and Server
 * Actions.
 *
 * Two things differ from the browser client:
 *
 *  1. It calls the API's real origin directly. The /api/v1 rewrite only exists
 *     to give the *browser* a same-origin path; going through it from the
 *     server would be a pointless extra hop through Next.
 *
 *  2. Cookies are forwarded manually. Server-side fetch carries no cookie jar,
 *     so the incoming request's cookies are read and passed on.
 *
 * There is deliberately NO refresh-and-retry here. A Server Component cannot
 * set cookies, so a rotated refresh token would be minted and immediately lost
 * — burning the session. If the access token has expired server-side, the
 * caller should redirect to sign-in and let the browser client refresh.
 */

export interface ServerRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
}

function buildUrl(path: string, query?: ServerRequestOptions['query']): string {
  const url = new URL(`/v1/${path.replace(/^\//, '')}`, env.API_ORIGIN)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }
  return url.toString()
}

export async function serverFetch<T>(path: string, options: ServerRequestOptions = {}): Promise<T> {
  const { body, query, headers, ...rest } = options
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()

  const response = await fetch(buildUrl(path, query), {
    ...rest,
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // Authenticated reads must never be cached across users.
    cache: 'no-store',
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const json: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    // Narrow rather than assert: a failing upstream may well return something
    // that is not our error envelope at all (a proxy's HTML 502 page, say).
    const failure: Partial<ApiFailure> = typeof json === 'object' && json !== null ? json : {}
    throw new ApiError(response.status, failure)
  }

  return (json as ApiSuccess<T>).data
}

/**
 * Returns null on any failure rather than throwing — for optional reads.
 *
 * Null is the right ANSWER for a read the page can do without. It is a poor
 * DIAGNOSIS: a rejected request and an empty result arrive here identically,
 * and the page renders "nothing to show" either way.
 *
 * That has cost real time. A picker asking for `limit: 200` against an API
 * that caps at 100 is a 422, swallowed here, and the screen reads "this
 * platform has no organisations". It happened three times in three different
 * pickers before anyone recognised the pattern.
 *
 * So a 4xx is logged. Not shown — the caller chose to treat failure as
 * absence and that is still what the reader sees — but written down, so the
 * next one is a grep rather than a hunt. 5xx and network failures are left
 * alone: they are already loud elsewhere and would drown the signal.
 */
export async function serverFetchOrNull<T>(
  path: string,
  options?: ServerRequestOptions,
): Promise<T | null> {
  try {
    return await serverFetch<T>(path, options)
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      console.error('[serverFetchOrNull] request refused, returning null', {
        path,
        status: error.status,
        message: error.message,
      })
    }
    return null
  }
}

/**
 * A list read that keeps `meta` as well as `data`.
 *
 * `serverFetch` returns the unwrapped `data` and DISCARDS `meta`, which is
 * right for a single resource and wrong for a paginated list — the page count
 * and total live in `meta`, so a caller that needs to render pagination has
 * nothing to render it from. Reaching for `serverFetch` on a list endpoint and
 * then reading `response.data` is the natural mistake, and it fails quietly:
 * `data` is `undefined` on an already-unwrapped array, so the list renders as
 * an error state rather than throwing anywhere useful.
 *
 * This returns the envelope intact. `meta` is optional because not every list
 * endpoint paginates.
 */
export async function serverFetchPage<T>(
  path: string,
  options: ServerRequestOptions = {},
): Promise<{ data: T[]; meta?: PageMeta }> {
  const { body, query, headers, ...rest } = options
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()

  const response = await fetch(buildUrl(path, query), {
    ...rest,
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  })

  const text = await response.text()
  const json: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const failure: Partial<ApiFailure> = typeof json === 'object' && json !== null ? json : {}
    throw new ApiError(response.status, failure)
  }

  const envelope = json as ApiSuccess<T[]>
  return { data: envelope.data, meta: envelope.meta }
}

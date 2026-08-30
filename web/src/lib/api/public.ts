import 'server-only'
import { env } from '@/lib/env'
import { ApiError, type ApiFailure, type PageMeta } from './types'

/**
 * Unauthenticated, cacheable reads for public marketing content — currently
 * just the blog.
 *
 * Deliberately NOT `serverFetch` (`lib/api/server.ts`): that helper forwards
 * the visitor's session cookie and hardcodes `cache: 'no-store'`, which is
 * right for the always-fresh, per-session admin portal and wrong here — a
 * public blog page has no session to forward and should be cacheable across
 * every visitor.
 *
 * Reads are tagged (`next.tags`) so an admin's publish/save action can
 * invalidate exactly the right pages via `updateTag` — see
 * `web/src/app/app/admin/blog/actions.ts`.
 */

export interface PublicRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>
  /** Cache tags and/or a revalidation window. Defaults to a 5-minute revalidate with no tags. */
  next?: { tags?: string[]; revalidate?: number | false }
}

function buildUrl(path: string, query?: PublicRequestOptions['query']): string {
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

/** A single resource — `data` unwrapped, `meta` (if any) discarded. */
export async function publicFetch<T>(path: string, options: PublicRequestOptions = {}): Promise<T> {
  const response = await fetch(buildUrl(path, options.query), {
    next: options.next ?? { revalidate: 300 },
  })

  const text = await response.text()
  const json: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const failure: Partial<ApiFailure> = typeof json === 'object' && json !== null ? json : {}
    throw new ApiError(response.status, failure)
  }

  return (json as { data: T }).data
}

/** A list read that keeps `meta` — see the equivalent note on `serverFetchPage`. */
export async function publicFetchPage<T>(
  path: string,
  options: PublicRequestOptions = {},
): Promise<{ data: T[]; meta?: PageMeta }> {
  const response = await fetch(buildUrl(path, options.query), {
    next: options.next ?? { revalidate: 300 },
  })

  const text = await response.text()
  const json: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const failure: Partial<ApiFailure> = typeof json === 'object' && json !== null ? json : {}
    throw new ApiError(response.status, failure)
  }

  const envelope = json as { data: T[]; meta?: PageMeta }
  return { data: envelope.data, meta: envelope.meta }
}

/**
 * Like `publicFetch`, but keeps extra top-level envelope fields alongside
 * `data` — needed for `GET /blog/posts/:slug`, whose response also carries
 * `redirectTo` when the slug was found via `previousSlugs` rather than
 * directly (see `getPostPublic` in the API's blog service).
 */
export async function publicFetchWithExtras<T, Extra extends Record<string, unknown>>(
  path: string,
  options: PublicRequestOptions = {},
): Promise<{ data: T } & Extra> {
  const response = await fetch(buildUrl(path, options.query), {
    next: options.next ?? { revalidate: 300 },
  })

  const text = await response.text()
  const json: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const failure: Partial<ApiFailure> = typeof json === 'object' && json !== null ? json : {}
    throw new ApiError(response.status, failure)
  }

  return json as { data: T } & Extra
}

/** Returns `null` on any failure rather than throwing — for optional reads. */
export async function publicFetchOrNull<T>(
  path: string,
  options?: PublicRequestOptions,
): Promise<T | null> {
  try {
    return await publicFetch<T>(path, options)
  } catch {
    return null
  }
}

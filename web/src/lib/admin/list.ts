import 'server-only'
import { serverFetchPage } from '@/lib/api/server'
import { ApiError, type PageMeta } from '@/lib/api/types'

/**
 * The shared list-read for every admin section.
 *
 * A 403 is a *state*, not a crash: a sub-admin without the grant should see
 * "you don't have access to this", not the error boundary. So the failure is
 * returned as a value rather than thrown, and the page renders it as an empty
 * state. Anything else collapses to `unknown`, which the page renders as
 * "couldn't load".
 *
 * `serverFetchPage`, not `serverFetch` — the latter unwraps to `data` and drops
 * `meta`, which is where the total and page count live. See the note on that
 * function.
 */

export type ListResult<Row> =
  | { items: Row[]; meta: PageMeta }
  | { error: 'forbidden' | 'unknown' }

export interface LoadListOptions {
  /** 1-based page number, already clamped by the caller. */
  page: number
  /** Rows per page. */
  limit: number
  /** Extra query parameters — filters, search terms. */
  query?: Record<string, string | number | boolean | undefined | null>
}

export async function loadList<Row>(
  path: string,
  { page, limit, query }: LoadListOptions,
): Promise<ListResult<Row>> {
  try {
    const response = await serverFetchPage<Row>(path, {
      query: { ...query, page, limit },
    })
    return {
      items: response.data,
      meta:
        response.meta ?? {
          page,
          limit,
          total: response.data.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return { error: 'forbidden' }
    return { error: 'unknown' }
  }
}

/** Parse a `?page=` value into a safe 1-based page number. */
export function parsePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '1', 10)
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 1
}

/**
 * Build the `hrefFor` callback the Pagination component needs, preserving the
 * filters that are already in the URL.
 *
 * `page=1` is omitted so the first page has the canonical, bare URL.
 */
export function pageHrefBuilder(
  basePath: string,
  params: Record<string, string | undefined>,
): (page: number) => string {
  return (targetPage: number) => {
    const sp = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value) sp.set(key, value)
    }
    if (targetPage > 1) sp.set('page', String(targetPage))
    const qs = sp.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }
}

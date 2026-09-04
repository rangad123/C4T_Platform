import { NextResponse } from 'next/server'
import { serverFetchPage } from '@/lib/api/server'
import { getUser, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'

export const dynamic = 'force-dynamic'

/**
 * `/app/admin/projects/[id]/assign/candidates` — the assignment picker's
 * search, callable from the browser.
 *
 * ── WHY A ROUTE HANDLER AND NOT A SERVER COMPONENT READ
 *
 * Selection has to survive typing, filtering and paging. If each of those
 * were a server navigation, the workspace would re-render from the top and
 * the chosen testers would have to be carried in the URL — which does not
 * scale past a handful, and which turns "select all visible" into a URL long
 * enough to break. Fetching from the client instead keeps selection in one
 * place: React state that nothing navigates away from.
 *
 * `API_ORIGIN` is server-side only (loopback), so the browser cannot call the
 * API directly. This proxies with the caller's cookie, the same shape the
 * upload and download routes use.
 *
 * AUTHORIZATION IS THE API'S. `GET /v1/testers/assignment-candidates` is
 * guarded by the same permission as assignment itself and 404s an unknown
 * build. The check here only keeps the obviously-unentitled out of a route
 * that would refuse them a moment later anyway.
 */

/** Forwarded verbatim; anything else the API would reject as unknown. */
const PASS_THROUGH = [
  'buildId',
  'search',
  'status',
  'countryCode',
  'city',
  'skills',
  'languages',
  'deviceType',
  'osName',
  'browser',
  'minRating',
  'sort',
  'order',
  'page',
  'limit',
] as const

export async function GET(request: Request): Promise<Response> {
  const user = await getUser()
  if (!user || !hasPermission(user, 'project.assign')) {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const incoming = new URL(request.url).searchParams
  const query: Record<string, string> = {}
  for (const key of PASS_THROUGH) {
    const value = incoming.get(key)
    if (value !== null && value !== '') query[key] = value
  }
  if (!query.buildId) {
    return NextResponse.json({ error: 'A build is required.' }, { status: 400 })
  }

  try {
    const { data, meta } = await serverFetchPage<unknown>('testers/assignment-candidates', {
      query,
    })
    return NextResponse.json({ data, meta })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    return NextResponse.json(
      {
        error:
          status === 404
            ? 'That build no longer exists.'
            : status === 403
              ? 'You cannot assign testers on this project.'
              : 'Could not search testers. Try again.',
      },
      { status: status === 404 || status === 403 ? status : 502 },
    )
  }
}

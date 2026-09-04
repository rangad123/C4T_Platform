import { NextResponse } from 'next/server'
import { serverFetchPage } from '@/lib/api/server'
import { getUser, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'

export const dynamic = 'force-dynamic'

/**
 * `/app/admin/communication/compose/recipients` — the composer's tester
 * search, callable from the browser.
 *
 * `API_ORIGIN` is server-side only (loopback), so the browser cannot reach
 * the API directly. This proxies with the caller's cookie, the same shape the
 * assignment picker's own candidates route uses.
 *
 * It targets `GET /v1/testers/message-recipients` rather than `GET /testers`
 * on purpose: that endpoint answers with the lean candidate shape, so choosing
 * who receives a message no longer ships every tester's bio, gender, phone
 * number and work history into the page. See `listMessageRecipients`.
 *
 * AUTHORIZATION IS THE API'S — the endpoint is gated on `communication.write`,
 * the same permission as sending. The check here only keeps the obviously
 * unentitled out of a route that would refuse them a moment later anyway.
 */

/** Forwarded verbatim; anything else the API would reject as unknown. */
const PASS_THROUGH = [
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
  if (!user || !hasPermission(user, 'communication.write')) {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const incoming = new URL(request.url).searchParams
  const query: Record<string, string> = {}
  for (const key of PASS_THROUGH) {
    const value = incoming.get(key)
    if (value !== null && value !== '') query[key] = value
  }

  try {
    const { data, meta } = await serverFetchPage<unknown>('testers/message-recipients', { query })
    return NextResponse.json({ data, meta })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    return NextResponse.json(
      {
        error:
          status === 403
            ? 'You cannot send messages to testers.'
            : 'Could not search testers. Try again.',
      },
      { status: status === 403 ? 403 : 502 },
    )
  }
}

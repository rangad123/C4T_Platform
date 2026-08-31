import { NextResponse } from 'next/server'
import { serverFetch, serverFetchPage } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { resolveNotificationHref } from '@/lib/notifications/href'

/**
 * The notification bell's data, same-origin.
 *
 * The bell is a client component — it has to update its own badge the moment
 * something is read, without a navigation — so it needs an endpoint the
 * browser can call. It calls this rather than the API directly, matching the
 * rule the rest of the app follows: the browser never talks to the Express
 * service, so the session cookie never has to be readable from script.
 *
 * Links are resolved to this portal here rather than in the component, so
 * the mapping lives in one place and the client just follows an href.
 */

interface NotificationRow {
  id: string
  type: string
  title: string
  body: string | null
  link: string | null
  readAt: string | null
  createdAt: string
}

export async function GET(): Promise<NextResponse> {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  try {
    /**
     * Unread only. The panel is a list of what still needs attention, not an
     * archive — everything already read is one click away in the full list
     * and only makes the thing that does need attention harder to find.
     */
    const { data, meta } = await serverFetchPage<NotificationRow>('notifications', {
      query: { page: 1, limit: 20, unreadOnly: 'true' },
    })
    return NextResponse.json({
      notifications: data.map((n) => ({
        ...n,
        href: resolveNotificationHref(n.link, user.role),
      })),
      /**
       * The API's own count of every unread row, not the length of this page.
       * Counting the page capped the badge at 20 and, now that the page is
       * filtered, would have been the only number available — a reader with
       * 30 waiting would have been told 20.
       */
      unread: meta?.unreadCount ?? data.length,
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    return NextResponse.json({ error: 'unavailable' }, { status })
  }
}

/**
 * Marks one notification read, or all of them.
 *
 * `{ id }` for a single row, `{ all: true }` for the lot. The API owns the
 * ownership check either way — a notification id belonging to someone else
 * is not found for this caller.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  let body: { id?: string; all?: boolean }
  try {
    body = (await request.json()) as { id?: string; all?: boolean }
  } catch {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 })
  }

  try {
    if (body.all) {
      await serverFetch('notifications/read-all', { method: 'POST' })
    } else if (body.id) {
      await serverFetch(`notifications/${body.id}/read`, { method: 'POST' })
    } else {
      return NextResponse.json({ error: 'bad-request' }, { status: 400 })
    }
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    return NextResponse.json({ error: 'failed' }, { status })
  }

  return NextResponse.json({ ok: true })
}

import { NextResponse } from 'next/server'
import { env } from '@/lib/env'

/**
 * The `List-Unsubscribe` target for notification email.
 *
 * ── WHY THIS EXISTS AT ALL
 *
 * Gmail and Outlook show their own "Unsubscribe" control beside the sender
 * when a message carries `List-Unsubscribe` plus `List-Unsubscribe-Post`.
 * Pressing it makes the mail client POST here — no browser, no session, no
 * page shown to anyone. Recipients who have that button use it instead of the
 * spam button, and which of the two they press is one of the things that
 * decides whether this domain keeps reaching inboxes at all.
 *
 * ── WHY IT IS A ROUTE HANDLER AND NOT A PAGE
 *
 * A page cannot answer a POST. `/email-preferences` is the human-facing half
 * — it explains what happened and offers to undo it — and a GET here just
 * redirects there, so a mail client that follows the header URL with GET
 * (some still do) lands somewhere that makes sense.
 *
 * ── WHY IT TALKS TO THE API DIRECTLY
 *
 * Every other browser-facing handler forwards the caller's session. This one
 * has none by definition: the credential is the signed token in the query
 * string, which the API verifies. `serverFetch` is deliberately not used —
 * it exists to carry a session, and there is nothing to carry.
 */

function apiUrl(token: string): string {
  return new URL(
    `/v1/notifications/unsubscribe?token=${encodeURIComponent(token)}`,
    env.API_ORIGIN,
  ).toString()
}

async function unsubscribe(token: string): Promise<boolean> {
  if (!token) return false
  try {
    const response = await fetch(apiUrl(token), { method: 'POST', cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

/**
 * One-click, from the mail client. The response body is never seen by a
 * person, so it says the minimum; the status is what the client reads.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  const ok = await unsubscribe(token)
  return NextResponse.json({ ok }, { status: ok ? 200 : 400 })
}

/**
 * A person following the same URL. The work is done here rather than on the
 * page so the page stays a plain render with no side effect — a preview
 * fetcher or a link scanner hitting the page must not silently unsubscribe
 * anyone, and several of them do issue GETs.
 *
 * The outcome rides in the query string rather than the token, so the landing
 * page never has to re-do the write to know what happened.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  const ok = await unsubscribe(token)
  const destination = new URL('/email-preferences', env.NEXT_PUBLIC_SITE_URL)
  destination.searchParams.set('state', ok ? 'off' : 'invalid')
  if (ok) destination.searchParams.set('token', token)
  return NextResponse.redirect(destination, 303)
}

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { getUserOrUnknown } from '@/lib/auth/session'
import { aiStudioHandOff } from '@/lib/navigation/ai-studio'
import { ApiError } from '@/lib/api/types'

/**
 * The sidebar's "AI Studio" entry, and AI Studio's way back in.
 *
 * AI Studio (aistudio.crowd4test.com) has no sign-in of its own: it reads
 * this site's session cookie, scoped to the parent domain by
 * AUTH_COOKIE_DOMAIN (see `lib/auth/shared-session.ts`). Coming through here
 * first means Proxy has already renewed an expired session and re-scoped an
 * old one before the visitor lands there, and a signed-out visitor is sent to
 * sign in and then on to the page they asked for (`?to=`, see
 * `aiStudioHandOff`). A session that could not be read is not a sign-out:
 * the visitor is asked to reload instead of being sent to the sign-in form.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.AI_STUDIO_URL) return new NextResponse(null, { status: 404 })

  const to = request.nextUrl.searchParams.get('to')
  let user: Awaited<ReturnType<typeof getUserOrUnknown>>
  try {
    user = await getUserOrUnknown()
  } catch (error) {
    // A suspended or deactivated account: the API's own sentence, and no retry that could never work.
    if (!(error instanceof ApiError) || error.status !== 403) throw error
    return new NextResponse(error.message, {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  const next = aiStudioHandOff(user, to, env.AI_STUDIO_URL)
  const response =
    next.status === 503
      ? new NextResponse(
          'Crowd4Test could not check your sign-in just now. Reload this page in a moment.',
          { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' } },
        )
      : new NextResponse(null, { status: next.status, headers: { location: next.location! } })
  response.headers.set('cache-control', 'no-store')
  return response
}

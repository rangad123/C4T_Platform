import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { getUser } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/api/types'
import { canOpenAiStudio } from '@/lib/navigation/ai-studio'

/**
 * The sidebar's "AI Studio" entry, and AI Studio's way back in.
 *
 * AI Studio (aistudio.crowd4test.com) has no sign-in of its own: it reads
 * this site's session cookie, scoped to the parent domain by
 * AUTH_COOKIE_DOMAIN (see `lib/auth/shared-session.ts`). Coming through here
 * first means Proxy has already renewed an expired session and re-scoped an
 * old one before the visitor lands there, and a signed-out visitor is sent to
 * sign in and then on to the page they asked for.
 *
 * `?to=` is the AI Studio page to open, a path such as `/projects/abc`. It
 * becomes the hash of a URL on AI_STUDIO_URL, so it can never name another
 * host; anything that does not look like a path opens AI Studio's home.
 */
function studioPage(to: string | null): string {
  if (!to || !to.startsWith('/') || to.startsWith('//') || to.includes('\\') || to.length > 512) {
    return '/'
  }
  return to
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set('cache-control', 'no-store')
  return response
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.AI_STUDIO_URL) return new NextResponse(null, { status: 404 })

  const to = request.nextUrl.searchParams.get('to')
  const user = await getUser()
  if (!user) {
    const back = `/app/ai-studio${to ? `?to=${encodeURIComponent(to)}` : ''}`
    return noStore(
      new NextResponse(null, {
        status: 307,
        headers: { location: `/login?next=${encodeURIComponent(back)}` },
      }),
    )
  }
  // An account that has not finished onboarding has no portal, and no AI Studio.
  if (user.role === 'USER') {
    return noStore(new NextResponse(null, { status: 307, headers: { location: ROLE_HOME.USER } }))
  }
  /*
    Without `ai_studio.access` the sidebar has no entry, but a bookmark or a
    link from AI Studio still lands here. Back to their own portal home with
    a notice, the way `requireRole` sends a wrong-role visitor home, rather
    than a bare 403 page with no way back.
  */
  if (!canOpenAiStudio(user)) {
    const home = `${ROLE_HOME[user.role]}?notice=ai-studio-no-access`
    return noStore(new NextResponse(null, { status: 307, headers: { location: home } }))
  }

  const target = new URL(env.AI_STUDIO_URL)
  target.hash = studioPage(to)
  return noStore(NextResponse.redirect(target, 303))
}

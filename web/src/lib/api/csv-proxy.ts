import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { env } from '@/lib/env'

/**
 * Streams a CSV from the API on behalf of the browser.
 *
 * Why this exists: the admin list pages are Server Components, and the export
 * endpoints on the API are CORS + cookie-bound to the API origin. Rather than
 * point the browser at the API directly (which would either need a rewrite
 * proxy or a cross-origin cookie hop), the Next.js server fetches the CSV
 * with the user's cookies forwarded and streams the bytes back. The link in
 * the UI is a normal `<a>` to a same-origin path.
 *
 * Errors are forwarded verbatim so the user sees the real reason from the
 * API — an expired access token, a 422 from a bad filter, etc. — rather than
 * a generic 500.
 *
 * Always dynamic; never cache per-user CSV across requests.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params
  const upstreamPath = '/v1/' + path.join('/')
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.toString()

  const upstreamUrl = new URL(upstreamPath, env.API_ORIGIN)
  // Pass through the query string to preserve the filter set the user sees.
  _req.nextUrl.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.append(key, value)
  })

  const upstreamResponse = await fetch(upstreamUrl, {
    method: 'GET',
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  })

  if (!upstreamResponse.ok) {
    const body = await upstreamResponse.text()
    return new NextResponse(body, {
      status: upstreamResponse.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  const csv = await upstreamResponse.text()
  const contentType = upstreamResponse.headers.get('content-type') ?? 'text/csv; charset=utf-8'
  const contentDisposition = upstreamResponse.headers.get('content-disposition')
  const headers: Record<string, string> = { 'content-type': contentType }
  if (contentDisposition) headers['content-disposition'] = contentDisposition
  return new NextResponse(csv, { status: 200, headers })
}

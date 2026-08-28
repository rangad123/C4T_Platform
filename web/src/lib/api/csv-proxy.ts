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
 * Errors are NOT forwarded verbatim. The status code is preserved, but the
 * body is replaced with a plain sentence: this handler is reachable from the
 * customer portal, and the API's envelope carries internal phrasing
 * ("You do not have permission to report generate") that a client should
 * never be shown. The real reason stays in the API's own logs, keyed by the
 * request id it already records.
 *
 * Route segment config (`dynamic`, `runtime`) is declared by the route file
 * that imports this handler, not here, because Next.js cannot statically
 * resolve config fields that are re-exported from another module.
 */

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
    /**
     * Drain the upstream body so the connection is released, then discard it.
     * The status is what the caller acts on; the text is not for them.
     */
    await upstreamResponse.text().catch(() => '')
    const status = upstreamResponse.status
    const message =
      status === 401
        ? 'Your session has expired. Sign in and try the download again.'
        : status === 403 || status === 404
          ? 'That export is not available to you.'
          : status === 422
            ? 'That combination of filters cannot be exported. Adjust them and try again.'
            : 'The export could not be generated. Try again in a moment.'
    return new NextResponse(message, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const csv = await upstreamResponse.text()
  const contentType = upstreamResponse.headers.get('content-type') ?? 'text/csv; charset=utf-8'
  const contentDisposition = upstreamResponse.headers.get('content-disposition')
  const headers: Record<string, string> = { 'content-type': contentType }
  if (contentDisposition) headers['content-disposition'] = contentDisposition
  return new NextResponse(csv, { status: 200, headers })
}
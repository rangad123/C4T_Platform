import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'

export const dynamic = 'force-dynamic'

/**
 * `/app/customer/download/[fileId]` — hands the browser a stored file.
 *
 * Files are not public. `GET /v1/uploads/:id/download-url` mints a
 * short-lived signed URL and needs the caller's session cookie, which a plain
 * `<a href>` to the API would not carry: the cookie is scoped to the API's
 * origin and there is no same-origin rewrite for it. So the link points here,
 * this runs on the server with the cookie, and the browser is redirected to
 * the signed URL.
 *
 * AUTHORIZATION IS THE API'S, NOT THIS FILE'S. `assertCanDownload` walks the
 * file back to whatever owns it — a build's test document resolves through
 * that build's project and `project.read` — so an id belonging to someone
 * else's project is refused there. The role check below only keeps other
 * portals off this route; it is not what protects the file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const user = await getUser()
  if (user?.role !== 'CUSTOMER') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const { fileId } = await params

  let url: string
  try {
    const result = await serverFetch<{ url: string }>(`uploads/${fileId}/download-url`)
    url = result.url
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // Deliberately terse: a customer who cannot read this file should not learn
    // whether it exists, so 403 and 404 read the same from here.
    return NextResponse.json(
      {
        error:
          status === 404 || status === 403
            ? 'That file is not available.'
            : 'Could not fetch that file.',
      },
      { status: status === 404 || status === 403 ? 404 : 502 },
    )
  }

  // `redirect` throws to unwind — it must be the last statement and must not
  // sit inside the try/catch above.
  redirect(url)
}

import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'

export const dynamic = 'force-dynamic'

/**
 * `/app/files/[fileId]` — the `src` for a stored image.
 *
 * Stored files are private. Fetching one takes a short-lived signed URL that
 * only `GET /v1/uploads/:id/download-url` can mint, and minting needs the
 * session cookie — which is scoped to the API's origin, so the browser cannot
 * send it. This runs on the server, where the cookie is available, and
 * redirects the browser to the signed URL.
 *
 * ── WHY NOT `next/image`
 *
 * The image optimizer cannot serve this. For a same-origin `src` it builds a
 * mock request from the URL and the socket alone — `fetchInternalImage` in
 * `next/dist/server/image-optimizer.js` passes no headers, so the mint call
 * runs unauthenticated and 403s. It also never follows a redirect on that
 * path; a 307 arrives as an empty body and fails as "internal response is
 * invalid". Hence `Avatar` renders a plain `<img>` at this route and the
 * browser, which does have the cookie, follows the redirect itself.
 *
 * AUTHORIZATION IS THE API'S. `assertCanDownload` resolves the file's scope
 * back to the record that owns it, so a guessed id gets a 403 rather than a
 * signed URL. The session check below only keeps signed-out visitors out; it
 * is not what protects the file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  // A bare 401, not a redirect to `/login`: this is an image `src`, and
  // redirecting it to an HTML page just produces a confusing broken image.
  const user = await getUser()
  if (!user) return new NextResponse(null, { status: 401 })

  const { fileId } = await params

  let url: string
  try {
    const result = await serverFetch<{ url: string }>(`uploads/${fileId}/download-url`)
    url = result.url
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // 403 and 404 read the same from here, so a caller who may not see this
    // file does not learn whether it exists.
    return new NextResponse(null, { status: status === 403 || status === 404 ? 404 : 502 })
  }

  // `redirect` throws to unwind, so it must sit outside the try above.
  redirect(url)
}

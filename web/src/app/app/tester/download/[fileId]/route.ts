import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'

export const dynamic = 'force-dynamic'

/**
 * `/app/tester/download/[fileId]` — hands the browser a stored file.
 *
 * Files are not public. `GET /v1/uploads/:id/download-url` mints a short-lived
 * signed URL, and it needs the caller's session cookie — which a plain
 * `<a href>` to the API would not carry, because the cookie is scoped to the
 * API's own origin and there is no same-origin rewrite for it. So the link
 * points here, this runs on the server with the cookie, and the browser is
 * redirected to the signed URL.
 *
 * AUTHORIZATION IS THE API'S, NOT THIS FILE'S. `assertCanDownload` walks the
 * file's scope back to the record that owns it — a BUG_ATTACHMENT resolves
 * through `bug.read`, a PROJECT_MATERIAL through `project.read` — so a tester
 * who guesses another project's file id gets a 403 from the API rather than a
 * signed URL. The role check below is only to keep non-testers off a tester
 * route; it is not what protects the file.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const user = await getUser()
  if (user?.role !== 'TESTER') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const { fileId } = await params

  let url: string
  try {
    const result = await serverFetch<{ url: string }>(`uploads/${fileId}/download-url`)
    url = result.url
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // Deliberately terse: a tester who cannot read this file should not learn
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

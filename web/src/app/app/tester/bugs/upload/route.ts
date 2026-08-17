import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { env } from '@/lib/env'
import { getUser } from '@/lib/auth/session'

/**
 * Uploads one evidence file and returns its `fileId`.
 *
 * The API's upload flow is three calls — presign, PUT the bytes, mark
 * complete. All three run here, server-side, rather than in the browser,
 * for one blunt reason: the browser cannot authenticate against the API on
 * this deployment. There is no `/api/v1` rewrite, and the auth cookie is
 * issued for the API's own domain, so a cross-origin `fetch` from the page
 * would arrive with no credentials. Proxying keeps the cookie forwarding on
 * the server where it already works — the same approach the CSV export
 * route takes.
 *
 * It also collapses three browser round trips into one, which matters when
 * the payload is a screen recording.
 *
 * Returns `{ fileId, name }` on success so the caller can render a chip and
 * a hidden input; the bug form posts those ids as `attachmentFileIds`.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Mirrors the API's own default (`UPLOAD_MAX_BYTES`), so we reject early. */
const MAX_BYTES = 52_428_800

export async function POST(req: NextRequest): Promise<NextResponse> {
  // A Route Handler is a public endpoint — the page's own gate does not
  // cover it, so re-check here rather than assume the caller came via the UI.
  const user = await getUser()
  if (user?.role !== 'TESTER') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'No file supplied' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is larger than the ${Math.floor(MAX_BYTES / 1_048_576)}MB limit.` },
      { status: 400 },
    )
  }

  const cookieHeader = (await cookies()).toString()
  const authed = (extra?: HeadersInit): HeadersInit => ({
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
    ...extra,
  })

  // 1 — reserve a FileObject row and get a signed destination.
  const presignRes = await fetch(new URL('/v1/uploads/presign', env.API_ORIGIN), {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      scope: 'BUG_ATTACHMENT',
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    }),
    cache: 'no-store',
  })
  if (!presignRes.ok) {
    return NextResponse.json(
      { error: 'Could not start the upload.' },
      { status: presignRes.status },
    )
  }
  const presign = (await presignRes.json()) as {
    data: { fileId: string; uploadUrl: string; requiredHeaders: Record<string, string> }
  }

  // 2 — PUT the bytes to wherever presign pointed us. On the local driver
  // that is the API itself; on S3 it is a signed bucket URL, which must NOT
  // carry our cookies — so only `requiredHeaders` go on this request.
  const putRes = await fetch(presign.data.uploadUrl, {
    method: 'PUT',
    headers: presign.data.requiredHeaders,
    body: Buffer.from(await file.arrayBuffer()),
    cache: 'no-store',
  })
  if (!putRes.ok) {
    return NextResponse.json({ error: 'The file could not be stored.' }, { status: 502 })
  }

  // 3 — flip isComplete, which is what makes the file attachable. `createBug`
  // rejects any attachment that is not complete, so skipping this would fail
  // later and more confusingly.
  const completeRes = await fetch(
    new URL(`/v1/uploads/${presign.data.fileId}/complete`, env.API_ORIGIN),
    { method: 'POST', headers: authed(), cache: 'no-store' },
  )
  if (!completeRes.ok) {
    return NextResponse.json({ error: 'The upload did not finish.' }, { status: 502 })
  }

  return NextResponse.json({ fileId: presign.data.fileId, name: file.name })
}

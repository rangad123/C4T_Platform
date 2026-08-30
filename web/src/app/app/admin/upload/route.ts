import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getUser } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `/app/admin/upload` — an admin uploads one file.
 *
 * The same presign → PUT → complete flow as the tester route, for the scopes
 * the admin side needs. A Route Handler rather than a Server Action because
 * Server Actions cap request bodies well below a useful file size, and a proxy
 * rather than a direct browser call because the session cookie is scoped to
 * the API's origin.
 *
 * Returns `{ fileId, name }`. What the file is FOR is decided by whichever
 * Server Action the caller then posts that id through.
 */

/**
 * Scopes an admin may upload under.
 *
 * An allow-list, not a pass-through. `scope` is what `assertCanDownload`
 * branches on, and PLATFORM_DOCUMENT is readable by every signed-in account —
 * so letting the client name an arbitrary scope would let one upload be filed
 * as something with quite different read rules.
 */
const SCOPES = {
  'platform-document': 'PLATFORM_DOCUMENT',
} as const

/** Matches the API's own `UPLOAD_MAX_BYTES` default. */
const MAX_BYTES = 52_428_800

const ALLOWED: Record<keyof typeof SCOPES, readonly string[]> = {
  'platform-document': ['application/pdf'],
}

export async function POST(request: Request): Promise<Response> {
  const user = await getUser()
  if (user?.role !== 'ADMIN' && user?.role !== 'SUB_ADMIN') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const form = await request.formData()
  const file = form.get('file')
  const scopeField = form.get('scope')
  const scopeKey = (typeof scopeField === 'string' ? scopeField : '') as keyof typeof SCOPES

  if (!(scopeKey in SCOPES)) {
    return NextResponse.json({ error: 'Unknown upload type.' }, { status: 400 })
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'No file supplied' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'That file is larger than the 50MB limit.' }, { status: 400 })
  }

  const mimeType = file.type || 'application/octet-stream'
  if (!ALLOWED[scopeKey].includes(mimeType)) {
    return NextResponse.json({ error: 'That document has to be a PDF.' }, { status: 400 })
  }

  const cookie = request.headers.get('cookie') ?? ''

  const presignRes = await fetch(new URL('/v1/uploads/presign', env.API_ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      scope: SCOPES[scopeKey],
      originalName: file.name,
      mimeType,
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

  // Only the headers the signature covers — deliberately no cookies, since
  // this may be a signed URL on another origin.
  const putRes = await fetch(presign.data.uploadUrl, {
    method: 'PUT',
    headers: presign.data.requiredHeaders,
    body: Buffer.from(await file.arrayBuffer()),
    cache: 'no-store',
  })
  if (!putRes.ok) {
    // The presigned PUT failed against S3 (or the local driver) itself — this
    // is the one leg of the three-step dance that never goes through our own
    // API, so its error body is otherwise invisible.
    const bodyText = await putRes.text().catch(() => '')
    console.error(
      `[admin/upload] PUT to storage failed: ${putRes.status} ${putRes.statusText} — ${bodyText.slice(0, 2000)}`,
    )
    return NextResponse.json({ error: 'The file could not be stored.' }, { status: 502 })
  }

  const completeRes = await fetch(
    new URL(`/v1/uploads/${presign.data.fileId}/complete`, env.API_ORIGIN),
    { method: 'POST', headers: { cookie }, cache: 'no-store' },
  )
  if (!completeRes.ok) {
    return NextResponse.json({ error: 'The upload did not finish.' }, { status: 502 })
  }

  return NextResponse.json({ fileId: presign.data.fileId, name: file.name })
}

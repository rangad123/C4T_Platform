import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getUser } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `/app/tester/upload` — a tester uploads one file.
 *
 * The same three-step presign dance `bugs/upload` does, but for the scopes a
 * tester needs outside a bug report: their avatar and their signed NDA. It is
 * a Route Handler rather than a Server Action because Server Actions cap
 * request bodies far below a useful file size, and it proxies rather than
 * letting the browser call the API directly because the session cookie is
 * scoped to the API's origin.
 *
 * Returns `{ fileId, name }`. The caller then posts that id through a Server
 * Action to attach it to whatever record it belongs on — this route never
 * decides what the file is FOR.
 */

/**
 * Scopes a tester may upload under, mapped from a short client-supplied key.
 *
 * An allow-list, not a pass-through: `scope` decides who may later download
 * the file (`assertCanDownload` on the API branches on it), so letting the
 * client name an arbitrary scope would let a tester file something as, say,
 * a PROJECT_MATERIAL and inherit that scope's read rules.
 */
const SCOPES = {
  avatar: 'AVATAR',
  nda: 'TESTER_DOCUMENT',
} as const

/** Matches the API's own `UPLOAD_MAX_BYTES` default. */
const MAX_BYTES = 52_428_800

/** NDAs are documents; avatars are images. Anything else is a mistake. */
const ALLOWED: Record<keyof typeof SCOPES, readonly string[]> = {
  avatar: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  nda: ['application/pdf'],
}

export async function POST(request: Request): Promise<Response> {
  const user = await getUser()
  if (user?.role !== 'TESTER') {
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
    return NextResponse.json(
      {
        error:
          scopeKey === 'nda'
            ? 'The signed NDA has to be a PDF.'
            : 'Use a PNG, JPEG, WebP or GIF image.',
      },
      { status: 400 },
    )
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
    return NextResponse.json({ error: 'Could not start the upload.' }, { status: presignRes.status })
  }
  const presign = (await presignRes.json()) as {
    data: { fileId: string; uploadUrl: string; requiredHeaders: Record<string, string> }
  }

  // Only the headers the signature covers — deliberately no cookies, since
  // this may be a signed S3 URL on another origin.
  const putRes = await fetch(presign.data.uploadUrl, {
    method: 'PUT',
    headers: presign.data.requiredHeaders,
    body: Buffer.from(await file.arrayBuffer()),
    cache: 'no-store',
  })
  if (!putRes.ok) {
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

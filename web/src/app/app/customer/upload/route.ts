import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getUser } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `/app/customer/upload` — a customer uploads one file.
 *
 * The same presign → PUT → complete flow the tester and admin routes use, for
 * the two files the project wizard collects: the logo of the app under test
 * and the test document testers work from.
 *
 * A Route Handler rather than a Server Action because Server Actions cap
 * request bodies well below a useful file size, and a proxy rather than a
 * direct browser call because the session cookie is scoped to the API origin.
 *
 * Returns `{ fileId, name }`. What the file is FOR is decided by whichever
 * action later attaches that id to a project or a build.
 */

/**
 * Scopes a customer may upload under.
 *
 * An allow-list, not a pass-through: `scope` is what `assertCanDownload`
 * branches on. Naming an arbitrary scope would let one upload inherit another
 * scope's read rules — PLATFORM_DOCUMENT, for instance, is readable by every
 * signed-in account.
 */
const SCOPES = {
  'project-logo': 'PROJECT_LOGO',
  'test-document': 'PROJECT_MATERIAL',
} as const

/** Matches the API's own `UPLOAD_MAX_BYTES` default. */
const MAX_BYTES = 52_428_800

const ALLOWED: Record<keyof typeof SCOPES, readonly string[]> = {
  'project-logo': ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'],
  'test-document': [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
  ],
}

const REJECTION: Record<keyof typeof SCOPES, string> = {
  'project-logo': 'Use a PNG, JPEG, WebP, GIF or SVG image for the logo.',
  'test-document': 'Use a PDF, Word, Excel, CSV or plain-text file.',
}

export async function POST(request: Request): Promise<Response> {
  const user = await getUser()
  if (user?.role !== 'CUSTOMER') {
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
    return NextResponse.json({ error: REJECTION[scopeKey] }, { status: 400 })
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
  // this may be a signed URL on another origin.
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

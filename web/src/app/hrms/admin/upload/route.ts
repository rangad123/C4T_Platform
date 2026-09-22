import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getHrEmployee } from '@/lib/hrms/hr-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `/admin/upload` (visible without the `/hrms` prefix — see proxy.ts) — an HR
 * employee uploads one file. Structural copy of `app/app/admin/upload/route.ts`:
 * same presign → PUT → complete dance against `lib/storage.ts`, gated by
 * `getHrEmployee()` instead of the platform's `getUser()`, targeting
 * `/v1/hrms/uploads/*` instead of `/v1/uploads/*`.
 *
 * Despite living under `admin/`, `profile-picture` is open to any signed-in
 * employee — it is how someone sets their own photo from the Employee
 * Portal, not only how HR sets one from a record. `template` and `document`
 * stay ADMIN-only: a template is a company document, and a document upload
 * on this route is HR attaching a file to someone else's record. Who a
 * profile picture ends up ON is decided by the PATCH that follows this
 * upload, not by this route — an employee's own PATCH only ever touches
 * their own record.
 *
 * A Route Handler, not a Server Action, for the same reason as the platform
 * route: a Server Action body caps well below a useful file size, and the
 * session cookie must stay server-side, so the browser cannot call the API's
 * presign endpoint directly.
 */

const SCOPES = {
  'profile-picture': 'PROFILE_PICTURE',
  template: 'TEMPLATE',
  document: 'EMPLOYEE_DOCUMENT',
} as const

const MAX_BYTES: Record<keyof typeof SCOPES, number> = {
  'profile-picture': 5_242_880, // 5MB — a profile picture, not a document.
  template: 52_428_800, // 50MB — matches the platform's own UPLOAD_MAX_BYTES default.
  // A CV or offer letter, not a video. Ten of these per employee is the cap,
  // so the ceiling is per-file rather than per-person.
  document: 20_971_520, // 20MB
}

const ALLOWED: Record<keyof typeof SCOPES, readonly string[]> = {
  'profile-picture': ['image/png', 'image/jpeg', 'image/webp'],
  template: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
  ],
}

const MIME_ERROR: Record<keyof typeof SCOPES, string> = {
  'profile-picture': 'Use a PNG, JPEG or WebP image.',
  template: 'Use a PDF, Word or PowerPoint file.',
  document: 'Use a PDF, Word document or an image.',
}

export async function POST(request: Request): Promise<Response> {
  const employee = await getHrEmployee()
  if (!employee) {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const form = await request.formData()
  const file = form.get('file')
  const scopeField = form.get('scope')
  const scopeKey = (typeof scopeField === 'string' ? scopeField : '') as keyof typeof SCOPES

  if (!(scopeKey in SCOPES)) {
    return NextResponse.json({ error: 'Unknown upload type.' }, { status: 400 })
  }
  if (scopeKey !== 'profile-picture' && employee.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'No file supplied' }, { status: 400 })
  }
  if (file.size > MAX_BYTES[scopeKey]) {
    const maxMb = Math.floor(MAX_BYTES[scopeKey] / 1_048_576)
    return NextResponse.json(
      { error: `That file is larger than the ${maxMb}MB limit.` },
      { status: 400 },
    )
  }

  const mimeType = file.type || 'application/octet-stream'
  if (!ALLOWED[scopeKey].includes(mimeType)) {
    return NextResponse.json({ error: MIME_ERROR[scopeKey] }, { status: 400 })
  }

  const cookie = request.headers.get('cookie') ?? ''

  const presignRes = await fetch(new URL('/v1/hrms/uploads/presign', env.API_ORIGIN), {
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

  const putRes = await fetch(presign.data.uploadUrl, {
    method: 'PUT',
    headers: presign.data.requiredHeaders,
    body: Buffer.from(await file.arrayBuffer()),
    cache: 'no-store',
  })
  if (!putRes.ok) {
    const bodyText = await putRes.text().catch(() => '')
    console.error(
      `[hrms/admin/upload] PUT to storage failed: ${putRes.status} ${putRes.statusText} — ${bodyText.slice(0, 2000)}`,
    )
    return NextResponse.json({ error: 'The file could not be stored.' }, { status: 502 })
  }

  const completeRes = await fetch(
    new URL(`/v1/hrms/uploads/${presign.data.fileId}/complete`, env.API_ORIGIN),
    { method: 'POST', headers: { cookie }, cache: 'no-store' },
  )
  if (!completeRes.ok) {
    return NextResponse.json({ error: 'The upload did not finish.' }, { status: 502 })
  }

  return NextResponse.json({ fileId: presign.data.fileId, name: file.name })
}

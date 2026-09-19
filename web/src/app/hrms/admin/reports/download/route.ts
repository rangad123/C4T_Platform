import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getHrEmployee } from '@/lib/hrms/hr-session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `/admin/reports/download` — proxies `GET /v1/hrms/reports` and streams the
 * PDF straight back.
 *
 * A Route Handler rather than a direct browser call to the API: the browser
 * has no way to reach `env.API_ORIGIN` with the HR session cookie attached
 * (that cookie is scoped to this Next.js origin, not the API's), so every
 * authenticated GET has to be relayed through here — same reasoning as
 * `admin/upload/route.ts`. A real navigation (not a Server Action) because a
 * Server Action cannot stream binary bytes back as a browser download.
 */
export async function GET(request: Request): Promise<Response> {
  const employee = await getHrEmployee()
  if (employee?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 })
  }

  const search = new URL(request.url).search
  const cookie = request.headers.get('cookie') ?? ''

  const upstream = await fetch(new URL(`/v1/hrms/reports${search}`, env.API_ORIGIN), {
    headers: { cookie },
    cache: 'no-store',
  })

  if (!upstream.ok) {
    // This route is reached by a real navigation, so returning JSON here left
    // the admin staring at a raw error body on a blank page with no way back.
    // Send them to the form instead, with something readable on it.
    const body = await upstream.text().catch(() => '')
    let message = 'Could not generate that report.'
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string }
      const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      if (detail) message = detail
    } catch {
      // Not JSON — keep the generic message rather than showing raw HTML.
    }
    return NextResponse.redirect(
      new URL(`/admin/reports?error=${encodeURIComponent(message)}`, request.url),
    )
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/pdf',
      'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
    },
  })
}

import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { serverFetch } from '@/lib/api/server'
import { getHrEmployee } from '@/lib/hrms/hr-session'
import { ApiError } from '@/lib/api/types'

export const dynamic = 'force-dynamic'

/**
 * `/files/[fileId]` on hrms.crowd4test.com — the `src` for a stored HRMS image.
 *
 * HRMS's counterpart to `app/app/files/[fileId]/route.ts`, and the reason it
 * has to exist separately: that route reads the PLATFORM session and mints
 * through `/v1/uploads/*`, neither of which applies to an HR employee. More
 * immediately, `Avatar` pointed every picture at `/app/files/...`, and under
 * this hostname `hrmsRewrite` prefixes every path with `/hrms` — so the
 * browser asked for `/hrms/app/files/...`, which does not exist. Profile
 * pictures uploaded successfully and then never rendered anywhere in HRMS.
 *
 * See that route's own comment for why this is a plain `<img>` against a
 * redirecting route rather than `next/image`: the optimizer sends no cookies
 * and does not follow the redirect.
 *
 * Authorization is the API's — `/v1/hrms/uploads/:id/download-url` resolves
 * the file's scope back to the record that owns it. The check below only
 * keeps signed-out visitors out.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  // A bare 401 rather than a redirect to /login: this is an image `src`, and
  // sending it to an HTML page just renders as a broken image.
  const employee = await getHrEmployee()
  if (!employee) return new NextResponse(null, { status: 401 })

  const { fileId } = await params

  let url: string
  try {
    const result = await serverFetch<{ url: string }>(`hrms/uploads/${fileId}/download-url`)
    url = result.url
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502
    // 403 and 404 read alike from here, so a caller who may not see this file
    // does not learn whether it exists.
    return new NextResponse(null, { status: status === 403 || status === 404 ? 404 : 502 })
  }

  // `redirect` throws to unwind, so it must sit outside the try above.
  redirect(url)
}

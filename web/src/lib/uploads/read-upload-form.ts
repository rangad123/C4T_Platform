import 'server-only'
import { NextResponse } from 'next/server'

/**
 * The multipart body of an upload, or a plain-spoken refusal.
 *
 * `request.formData()` throws when the body cannot be parsed — in practice,
 * when it arrives cut short. An unhandled throw there is a bare 500 with an
 * empty body, which is how a tester's screen recording vanished with nothing
 * to say why. Answering 413 with a sentence lets the upload widget show it.
 *
 * The usual cause is the proxy's body buffer (`proxyClientMaxBodySize` in
 * `next.config.ts`), which silently keeps only the first part of a larger
 * request. That limit sits above the 50MB the upload routes accept, so if this
 * still fires the file really was bigger than that or the connection dropped.
 */
export async function readUploadForm(request: Request): Promise<FormData | NextResponse> {
  try {
    return await request.formData()
  } catch {
    return NextResponse.json(
      {
        error:
          'That file did not arrive in full. Files up to 50MB are accepted — try a smaller one, or check your connection and try again.',
      },
      { status: 413 },
    )
  }
}

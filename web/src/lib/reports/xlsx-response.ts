import 'server-only'
import { NextResponse } from 'next/server'

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** `P-0042 Build 1` → `P-0042-Build-1`: letters, digits and dashes only, safe in a `filename=`. */
export function fileSlug(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  )
}

/** A finished workbook as a download. */
export function xlsxResponse(file: Buffer, filename: string): Response {
  return new NextResponse(new Uint8Array(file), {
    headers: {
      'content-type': XLSX_CONTENT_TYPE,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}

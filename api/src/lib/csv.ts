/**
 * Tiny CSV writer — no external dependency.
 *
 * Why no library: every contributed CSV package either pulls in a full RFC 4178
 * bargain (quoted newlines, escapes, BOMs) or is a streaming multi-megabyte
 * affair. The admin export use case here is a few thousand rows, never more
 * than what fits comfortably in memory, and the only characters we need to
 * quote are commas, newlines, double quotes, and the Surrounding whitespace.
 * Anything else is opaque to the consumer.
 */

export type CsvCell = string | number | boolean | Date | null | undefined
export type CsvRow = readonly CsvCell[]

/**
 * Escape a single cell value for CSV. The empty string is returned as
 * literally that — an empty cell — so a `null` and a missing value read
 * identically to an Excel user. Numbers and booleans are stringified; dates
 * emit ISO 8601 (UTC, sortable).
 */
export function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  const str = typeof value === 'string' ? value : String(value)
  if (str.length === 0) return ''
  // Quote if it contains characters that would break a naive split — comma,
  // double quote, CR, LF, or a leading/trailing space that some parsers trim.
  if (/[",\r\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Serialize a header row and N body rows into a CSV string. Header labels
 * are passed through `escapeCsvCell` so even headers can contain commas.
 */
export function toCsv(headers: readonly string[], rows: readonly CsvRow[]): string {
  const lines: string[] = [headers.map(escapeCsvCell).join(',')]
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','))
  // CRLF is the only line terminator RFC 4180 acknowledges; some Windows
  // spreadsheet tools misread bare LF. Trailing CRLF is optional per the spec
  // but matters here — opening the file in Excel without a final newline can
  // drop the last row on certain configurations.
  return lines.join('\r\n') + '\r\n'
}

/**
 * Build a filename with a timestamp so successive exports don't clobber each
 * other when the user saves them all to the same Downloads folder. The
 * timestamp is in the local timezone, but the file consumer doesn't care —
 * the timestamp is for the user, not the data.
 */
export function timestampedFilename(stem: string, ext = 'csv'): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `${stem}-${stamp}.${ext}`
}

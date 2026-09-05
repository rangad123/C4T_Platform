import { NextResponse } from 'next/server'

/**
 * Building a report CSV — the shared half of the customer and admin
 * report downloads.
 *
 * ── READ THIS BEFORE ADDING A COLUMN
 *
 * CSV export was built once across this platform and removed entirely on
 * 2026-09-02 as a PII leak. The old `exportBugsCSV` emitted one row per bug
 * including the reporter's email address, and a customer-facing proxy meant a
 * customer could download testers' contact details from their own project
 * page. Eleven API routes, seven buttons and the API's own `lib/csv.ts` went
 * with it.
 *
 * What lives here is not that export restored. It builds files out of the
 * AGGREGATE figures a report page already renders — counts by severity,
 * status, type and reproducibility, and the summary tiles above them. There
 * is no per-bug row, no name, no email, and no tester identity of any kind,
 * which is the entire reason this is allowed to exist.
 *
 * So: a count is fine, a list of people is not. If a future change wants
 * bug-level or tester-level detail in a download, that is a decision about
 * identity columns and it needs making deliberately — not by adding a field
 * to a helper because the data happened to be in scope.
 *
 * Callers must also leave out figures that identify by arithmetic. The
 * by-project payload carries `testersByCountry`, and it is deliberately not
 * written by either route: a per-country head count identifies a person the
 * moment that count is one.
 */

/** The four bug distributions every report answers with. */
export interface BugBreakdown {
  total: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  byType: Record<string, number>
  byReproducibility: Record<string, number>
}

/**
 * One CSV field.
 *
 * Two separate jobs. Quoting handles commas, quotes and newlines so the shape
 * survives. The leading apostrophe on `= + - @` handles the other thing: a
 * spreadsheet reads those as the start of a formula, so a project someone
 * named `=cmd|...` would execute on open. Neither is optional — this file is
 * built to be opened in Excel.
 */
export function field(value: string | number): string {
  const raw = String(value ?? '')
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function row(...cells: (string | number)[]): string {
  return cells.map(field).join(',')
}

/** `IN_PROGRESS` → `In progress`, matching how the page labels the same values. */
export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
}

/**
 * A count block, e.g. "Bugs by severity". An empty distribution says so
 * rather than lying with a zero row for a category nobody used.
 */
export function countBlock(
  heading: string,
  label: string,
  counts: Record<string, number>,
): string[] {
  const entries = Object.entries(counts ?? {})
  if (entries.length === 0) return [heading, row(label, 'Count'), row('None recorded', 0), '']
  return [
    heading,
    row(label, 'Count'),
    ...entries.map(([key, count]) => row(titleCase(key), count)),
    '',
  ]
}

/** The four distributions under a total — the body of every report here. */
export function breakdownBlocks(bugs: BugBreakdown): string[] {
  return [
    'Summary',
    row('Metric', 'Value'),
    row('Total bugs', bugs.total),
    '',
    ...countBlock('Bugs by severity', 'Severity', bugs.bySeverity),
    ...countBlock('Bugs by status', 'Status', bugs.byStatus),
    ...countBlock('Bugs by type', 'Type', bugs.byType),
    ...countBlock('Bugs by reproducibility', 'Reproducibility', bugs.byReproducibility),
  ]
}

/** Safe for a `filename=` — letters, digits and dashes only. */
export function slug(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  )
}

export function csvResponse(lines: string[], filename: string): Response {
  // A BOM so Excel reads it as UTF-8 rather than the local codepage — without
  // it a project title with an en dash or an accent arrives mangled.
  //
  // Written as the escape `\uFEFF` rather than the literal character:
  // identical bytes on the wire, but the source no longer carries an
  // invisible zero-width mark that reads as a stray space to anyone editing
  // this line (and that `no-irregular-whitespace` rightly flags).
  const body = `\uFEFF${lines.join('\r\n')}\r\n`
  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}

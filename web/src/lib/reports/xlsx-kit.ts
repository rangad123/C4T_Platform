import 'server-only'
import type { Cell, Worksheet } from 'exceljs'
import type { ChartKind, ChartSpec } from '@/lib/reports/xlsx-charts'
import { FONT, INK, TEAL, argb } from '@/lib/reports/xlsx-palette'

/**
 * The small set of building blocks every sheet of the report workbook is made
 * from — text hygiene, number and date formats, the data table, and the
 * "breakdown" (a labelled count table with its chart beside it). Keeping them
 * here means the seven sheets differ in what they say, not in how they look.
 */

/** Shown wherever a value was not recorded. A real zero is always written as `0`. */
export const DASH = '—'

export const SHEET = {
  summary: 'Executive summary',
  analytics: 'Bug analytics',
  bugs: 'Detailed bug report',
  testers: 'Tester summary',
  tests: 'Test results',
  history: 'Bug history & comments',
  fields: 'Custom field answers',
  build: 'Project & build details',
} as const

export const FORMAT = {
  dateTime: 'dd mmm yyyy hh:mm',
  date: 'dd mmm yyyy',
  percent: '0%',
  percentOne: '0.0%',
  integer: '#,##0',
  decimalOne: '0.0',
} as const

/** Excel refuses a cell longer than this, and a sheet name is capped at 31. */
const CELL_LIMIT = 32_000

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/** Text that is safe to put in a cell: no control characters, within Excel's length limit. */
export function clean(value: string | null | undefined): string {
  const text = (value ?? '').replace(CONTROL, '').replace(/\r\n?/g, '\n').trim()
  return text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT)}… (shortened)` : text
}

/** Cleaned text, or a dash when there is none. */
export function textOrDash(value: string | null | undefined): string {
  return clean(value) || DASH
}

/** `IN_PROGRESS` → `In progress`. */
export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
}

export function personName(
  person: { firstName: string | null; lastName: string | null } | null | undefined,
): string {
  if (!person) return DASH
  return [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || 'Unknown'
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `12 Oct 2026`, in UTC — the same clock as every timestamp in the workbook. */
export function formatDay(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

export function formatTime(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${formatDay(date)} ${hh}:${mm} UTC`
}

export function monthLabel(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

export function shortDay(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

/** `IN` → `India`; a code Intl does not know stays as it was written. */
export function countryName(code: string | null | undefined): string {
  if (!code) return DASH
  try {
    return regionNames.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`
}

// ── Styles ───────────────────────────────────────────────────────────────────

export const fillOf = (hex: string) =>
  ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } }) as const

export const fontOf = (opts: {
  size?: number
  bold?: boolean
  italic?: boolean
  color?: string
  underline?: boolean
}) => ({
  name: FONT,
  size: opts.size ?? 10,
  bold: opts.bold ?? false,
  italic: opts.italic ?? false,
  underline: opts.underline ?? false,
  color: { argb: argb(opts.color ?? INK[900]) },
})

export const hairline = { style: 'thin', color: { argb: argb(INK[200]) } } as const

/** The off-white page every presentation sheet sits on (never pure white). */
export function paintCanvas(sheet: Worksheet, widths: readonly number[]): void {
  sheet.views = [{ showGridLines: false }]
  widths.forEach((width, index) => {
    const column = sheet.getColumn(index + 1)
    column.width = width
    column.style = { fill: fillOf(INK[50]), font: fontOf({}) }
  })
}

/**
 * A cell value that jumps to another sheet. A `HYPERLINK()` formula rather than
 * a hyperlink record: Excel and LibreOffice both follow it without the
 * external-relationship detour a record takes, and the cached `result` keeps
 * the label readable in viewers that do not calculate.
 */
export const sheetLink = (name: string, cell = 'A1'): { formula: string; result: string } => {
  const quoted = name.replace(/'/g, "''").replace(/"/g, '""')
  return {
    formula: `HYPERLINK("#'${quoted}'!${cell}","${name.replace(/"/g, '""')}")`,
    result: name,
  }
}

export function pageSetup(
  sheet: Worksheet,
  title: string,
  orientation: 'portrait' | 'landscape',
): void {
  sheet.pageSetup = {
    orientation,
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  }
  sheet.headerFooter = {
    oddHeader: `&L&"${FONT},Bold"&9${title.replace(/&/g, '&&')}`,
    oddFooter: `&L&"${FONT},Regular"&8Prepared by Crowd4Test&R&"${FONT},Regular"&8Page &P of &N`,
  }
}

/** A page title block: heading, subtitle and a muted line. Returns the next free row. */
export function titleBlock(
  sheet: Worksheet,
  opts: {
    row: number
    fromCol: number
    toCol: number
    title: string
    subtitle?: string
    note?: string
  },
): number {
  let row = opts.row
  const merge = (r: number) => {
    if (opts.toCol > opts.fromCol) sheet.mergeCells(r, opts.fromCol, r, opts.toCol)
    return sheet.getCell(r, opts.fromCol)
  }

  const title = merge(row)
  title.value = opts.title
  title.font = fontOf({ size: 20, bold: true })
  title.alignment = { vertical: 'middle' }
  sheet.getRow(row).height = 32
  row += 1

  if (opts.subtitle) {
    const subtitle = merge(row)
    subtitle.value = opts.subtitle
    subtitle.font = fontOf({ size: 12, bold: true, color: TEAL[600] })
    subtitle.alignment = { vertical: 'middle', wrapText: opts.toCol > opts.fromCol }
    sheet.getRow(row).height = 20
    row += 1
  }
  if (opts.note) {
    const note = merge(row)
    note.value = opts.note
    note.font = fontOf({ size: 9, color: INK[600] })
    note.alignment = { vertical: 'top', wrapText: opts.toCol > opts.fromCol }
    row += 1
  }
  return row
}

/** A section heading with a teal rule under it. */
export function sectionHeading(
  sheet: Worksheet,
  row: number,
  fromCol: number,
  toCol: number,
  label: string,
): void {
  if (toCol > fromCol) sheet.mergeCells(row, fromCol, row, toCol)
  const cell = sheet.getCell(row, fromCol)
  cell.value = label
  cell.font = fontOf({ size: 12, bold: true, color: INK[900] })
  cell.alignment = { vertical: 'middle' }
  sheet.getRow(row).height = 22
  for (let col = fromCol; col <= toCol; col += 1) {
    sheet.getCell(row, col).border = {
      bottom: { style: 'medium', color: { argb: argb(TEAL[500]) } },
    }
  }
}

/** A paragraph in a merged band; the row is sized to the text because Excel will not size a merged cell. */
export function paragraph(
  sheet: Worksheet,
  opts: {
    row: number
    fromCol: number
    toCol: number
    text: string
    charsPerLine: number
    size?: number
    color?: string
    bullet?: boolean
  },
): void {
  const { row, fromCol, toCol } = opts
  if (toCol > fromCol) sheet.mergeCells(row, fromCol, row, toCol)
  const cell = sheet.getCell(row, fromCol)
  cell.value = opts.bullet ? `•  ${opts.text}` : opts.text
  cell.font = fontOf({ size: opts.size ?? 10, color: opts.color ?? INK[800] })
  cell.alignment = { vertical: 'top', wrapText: true, indent: opts.bullet ? 0 : 0 }
  const lines = Math.max(1, Math.ceil(opts.text.length / opts.charsPerLine))
  sheet.getRow(row).height = Math.max(16, lines * 14 + 4)
}

/** A label above a value, as a card in the figures grid. */
export function kpiCard(
  sheet: Worksheet,
  opts: {
    row: number
    col: number
    span: number
    label: string
    value: string | number
    note?: string
    format?: string
  },
): void {
  const { row, col, span } = opts
  const last = col + span - 1
  for (let r = row; r < row + 3; r += 1) {
    if (span > 1) sheet.mergeCells(r, col, r, last)
    for (let c = col; c <= last; c += 1) {
      const cell = sheet.getCell(r, c)
      cell.fill = fillOf(INK[100])
      if (c === col) {
        cell.border = { left: { style: 'thick', color: { argb: argb(TEAL[500]) } } }
      }
    }
  }
  const label = sheet.getCell(row, col)
  label.value = opts.label
  label.font = fontOf({ size: 9, color: INK[600] })
  label.alignment = { vertical: 'bottom', indent: 1, wrapText: true }

  const value = sheet.getCell(row + 1, col)
  value.value = opts.value
  value.font = fontOf({
    size: typeof opts.value === 'number' ? 22 : 14,
    bold: true,
    color: INK[900],
  })
  value.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
  if (opts.format) value.numFmt = opts.format

  const note = sheet.getCell(row + 2, col)
  note.value = opts.note ?? ''
  note.font = fontOf({ size: 9, color: INK[500] })
  note.alignment = { vertical: 'top', indent: 1, wrapText: true }

  sheet.getRow(row).height = 22
  sheet.getRow(row + 1).height = 32
  sheet.getRow(row + 2).height = 26
}

/** Label/value pairs, labels muted, values in ink. */
export function pairRow(
  sheet: Worksheet,
  opts: {
    row: number
    labelCol: number
    labelSpan: number
    valueCol: number
    valueSpan: number
    label: string
    value: string | number
  },
): void {
  const merge = (col: number, span: number) => {
    if (span > 1) sheet.mergeCells(opts.row, col, opts.row, col + span - 1)
    return sheet.getCell(opts.row, col)
  }
  const label = merge(opts.labelCol, opts.labelSpan)
  label.value = opts.label
  label.font = fontOf({ size: 9, color: INK[600] })
  label.alignment = { vertical: 'middle' }
  const value = merge(opts.valueCol, opts.valueSpan)
  value.value = opts.value
  value.font = fontOf({ size: 10, bold: true })
  value.alignment = { vertical: 'middle', wrapText: true, horizontal: 'left' }
}

// ── The data table ───────────────────────────────────────────────────────────

export type ColumnKind =
  'text' | 'long' | 'date' | 'datetime' | 'integer' | 'decimal' | 'percent' | 'link'

export interface TableColumn<T> {
  header: string
  width: number
  kind?: ColumnKind
  value: (row: T) => string | number | Date | null
}

export interface TableResult {
  /** First and last body row, 1-based. */
  firstRow: number
  lastRow: number
}

function styleBodyCell(cell: Cell, kind: ColumnKind): void {
  cell.font = fontOf({})
  cell.border = { bottom: hairline }
  const wrap = kind === 'text' || kind === 'long' || kind === 'link'
  cell.alignment = {
    vertical: 'top',
    wrapText: wrap,
    horizontal: kind === 'integer' || kind === 'decimal' || kind === 'percent' ? 'right' : 'left',
  }
  switch (kind) {
    case 'date':
      cell.numFmt = FORMAT.date
      break
    case 'datetime':
      cell.numFmt = FORMAT.dateTime
      break
    case 'integer':
      cell.numFmt = FORMAT.integer
      break
    case 'decimal':
      cell.numFmt = FORMAT.decimalOne
      break
    case 'percent':
      cell.numFmt = FORMAT.percent
      break
    default:
      break
  }
}

/**
 * An Excel table — banded, filterable, sortable — with a dark header row.
 * `rows` must not be empty (a table needs a body); callers say what is missing
 * in words instead when there is nothing to list.
 */
export function addDataTable<T>(
  sheet: Worksheet,
  opts: { name: string; headerRow: number; columns: readonly TableColumn<T>[]; rows: readonly T[] },
): TableResult {
  const { headerRow, columns, rows } = opts

  sheet.addTable({
    name: opts.name,
    ref: `A${headerRow}`,
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleLight1', showRowStripes: true },
    columns: columns.map((c) => ({ name: c.header, filterButton: true })),
    rows: rows.map((row) => columns.map((c) => c.value(row))),
  })

  const header = sheet.getRow(headerRow)
  header.height = 30
  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width
    const cell = header.getCell(index + 1)
    cell.font = fontOf({ bold: true, color: INK[50] })
    cell.fill = fillOf(INK[900])
    cell.alignment = { vertical: 'middle', wrapText: true }
  })

  const firstRow = headerRow + 1
  const lastRow = headerRow + rows.length
  for (let r = firstRow; r <= lastRow; r += 1) {
    columns.forEach((column, index) => {
      styleBodyCell(sheet.getCell(r, index + 1), column.kind ?? 'text')
    })
  }
  return { firstRow, lastRow }
}

/** A link only if it is plainly a web address — anything else stays inert text. */
export function webLink(
  value: string | null | undefined,
): string | { text: string; hyperlink: string } {
  const text = clean(value)
  if (!text) return DASH
  return /^https?:\/\/\S+$/i.test(text) ? { text, hyperlink: text } : text
}

// ── A labelled count table with its chart ────────────────────────────────────

export interface BreakdownItem {
  label: string
  value: number
  /** The chart colour for this item, six-digit RGB. */
  color: string
}

export interface BreakdownOptions {
  sheetName: string
  /** Top-left of the table, 1-based. */
  row: number
  col: number
  heading: string
  labelHeader: string
  valueHeader: string
  items: readonly BreakdownItem[]
  /** Add a share-of-total column. */
  showShare?: boolean
  kind: ChartKind
  chartTitle: string
  chartDescription: string
  /** Where the chart goes, zero-based cell corners. */
  chartFrom: { col: number; row: number }
  chartTo: { col: number; row: number }
  /** Shown under the table. */
  footnote?: string
}

/**
 * A heading, a count table (with its share of the total when asked) and the
 * ChartSpec that draws it. The table is plain cells rather than an Excel table
 * so several can sit in one sheet; the chart points at those cells.
 */
export function breakdown(
  sheet: Worksheet,
  opts: BreakdownOptions,
): { endRow: number; chart: ChartSpec | null } {
  const { row, col, items } = opts
  const valueCol = col + 1
  const shareCol = col + 2
  const total = items.reduce((sum, item) => sum + item.value, 0)

  sectionHeading(sheet, row, col, opts.showShare ? shareCol : valueCol, opts.heading)

  const headerRow = row + 1
  const headers = [opts.labelHeader, opts.valueHeader, ...(opts.showShare ? ['Share'] : [])]
  headers.forEach((text, index) => {
    const cell = sheet.getCell(headerRow, col + index)
    cell.value = text
    cell.font = fontOf({ size: 9, bold: true, color: INK[50] })
    cell.fill = fillOf(INK[900])
    cell.alignment = { vertical: 'middle', horizontal: index === 0 ? 'left' : 'right' }
  })
  sheet.getRow(headerRow).height = 20

  items.forEach((item, index) => {
    const r = headerRow + 1 + index
    const label = sheet.getCell(r, col)
    label.value = item.label
    label.font = fontOf({})
    label.fill = fillOf(INK[100])
    label.border = { bottom: hairline }

    const value = sheet.getCell(r, valueCol)
    value.value = item.value
    value.numFmt = FORMAT.integer
    value.font = fontOf({ bold: true })
    value.alignment = { horizontal: 'right' }
    value.fill = fillOf(INK[100])
    value.border = { bottom: hairline }

    if (opts.showShare) {
      const share = sheet.getCell(r, shareCol)
      share.value = percent(item.value, total)
      share.numFmt = FORMAT.percent
      share.font = fontOf({ color: INK[600] })
      share.alignment = { horizontal: 'right' }
      share.fill = fillOf(INK[100])
      share.border = { bottom: hairline }
    }
  })

  const firstItemRow = headerRow + 1
  const lastItemRow = headerRow + items.length
  let endRow = lastItemRow

  if (opts.footnote) {
    endRow += 1
    const note = sheet.getCell(endRow, col)
    note.value = opts.footnote
    note.font = fontOf({ size: 8, italic: true, color: INK[500] })
  }

  // A chart of nothing but zeros says nothing; the table above already does.
  const chart: ChartSpec | null =
    items.length > 0 && total > 0
      ? {
          sheet: opts.sheetName,
          kind: opts.kind,
          title: opts.chartTitle,
          description: opts.chartDescription,
          categories: {
            sheet: opts.sheetName,
            column: col,
            firstRow: firstItemRow,
            lastRow: lastItemRow,
          },
          values: {
            sheet: opts.sheetName,
            column: valueCol,
            firstRow: firstItemRow,
            lastRow: lastItemRow,
          },
          seriesName: {
            sheet: opts.sheetName,
            column: valueCol,
            row: headerRow,
            text: opts.valueHeader,
          },
          categoryLabels: items.map((i) => i.label),
          valueNumbers: items.map((i) => i.value),
          colors: items.map((i) => i.color),
          from: opts.chartFrom,
          to: opts.chartTo,
        }
      : null

  return { endRow, chart }
}

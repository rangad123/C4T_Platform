import 'server-only'
import ExcelJS from 'exceljs'
import {
  DONE_STATUSES,
  OPEN_STATUSES,
  REPRODUCIBILITY_ORDER,
  SEVERITY_ORDER,
  STATUS_ORDER,
  TYPE_ORDER,
  countsFromRecord,
  sumOf,
  type Count,
} from '@/lib/reports/build-report-facts'
import { addCharts, type ChartSpec } from '@/lib/reports/xlsx-charts'
import {
  DASH,
  addDataTable,
  breakdown,
  clean,
  formatTime,
  kpiCard,
  pageSetup,
  paintCanvas,
  pairRow,
  paragraph,
  percent,
  plural,
  sectionHeading,
  titleBlock,
  type BreakdownItem,
  type TableColumn,
} from '@/lib/reports/xlsx-kit'
import { INK, SERIES, SEVERITY_TONE, STATUS_TONE, TEAL, argb } from '@/lib/reports/xlsx-palette'

/**
 * The Reports module's downloads — by project, by build, by date and by build
 * range — as the same kind of workbook the per-build report is.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CONTAIN
 *
 * Aggregate counts only: no per-bug row, no tester name, no email. That is the
 * rule for everything under the Reports module (`report-csv.ts` carries the
 * argument for it), and unlike the per-build report this one has no reason to
 * widen it. The by-date report's per-project bug counts are organisational,
 * not personal, and are already on the page.
 */

export interface SummaryFigure {
  label: string
  value: string | number
  note?: string
  format?: string
}

/** A plain list beside the breakdowns — builds in a range, bugs per project. */
export interface SummaryList {
  sheetName: string
  heading: string
  headers: readonly string[]
  /** Which columns are counts (right-aligned, formatted). */
  numeric: readonly number[]
  rows: readonly (readonly (string | number)[])[]
  /** Also draw the biggest ten as a bar chart on the analytics sheet. */
  chart?: { labelColumn: number; valueColumn: number; title: string; valueHeader: string }
}

export interface SummaryReportInput {
  /** `By project`, `By date` … */
  kind: string
  generatedAt: Date
  /** The line under the title: the project, the dates. */
  subtitle: string
  /** Label/value pairs shown at the top (organisation, period …). */
  facts: readonly (readonly [string, string])[]
  /** The report's own figures; the bug figures are added from the distributions. */
  figures: readonly SummaryFigure[]
  bugs: {
    total: number
    bySeverity: Record<string, number>
    byStatus: Record<string, number>
    byType: Record<string, number>
    byReproducibility: Record<string, number>
  }
  lists: readonly SummaryList[]
}

const NOTE = 'A dash (—) means the value was not recorded; 0 is a real zero.'

const SHEETS = { summary: 'Summary', analytics: 'Bug analytics' } as const

const toneItems = (
  counts: readonly Count[],
  tones: Record<string, { solid: string }>,
): BreakdownItem[] =>
  counts.map((c) => ({ label: c.label, value: c.value, color: tones[c.key]?.solid ?? INK[500] }))

const seriesItems = (counts: readonly Count[]): BreakdownItem[] =>
  counts.map((c, i) => ({
    label: c.label,
    value: c.value,
    color: SERIES[i % SERIES.length] ?? INK[500],
  }))

const valueOf = (counts: readonly Count[], key: string): number =>
  counts.find((c) => c.key === key)?.value ?? 0

function findings(
  total: number,
  bySeverity: readonly Count[],
  byStatus: readonly Count[],
  byType: readonly Count[],
  byReproducibility: readonly Count[],
): string[] {
  if (total === 0) return ['No bugs were reported.']
  const severe = valueOf(bySeverity, 'CRITICAL') + valueOf(bySeverity, 'HIGH')
  const open = sumOf(byStatus, OPEN_STATUSES)
  const done = sumOf(byStatus, DONE_STATUSES)
  const out = [
    `${plural(total, 'bug')} ${total === 1 ? 'was' : 'were'} reported.`,
    `${severe} of ${total} bugs (${Math.round(percent(severe, total) * 100)}%) are critical or high severity.`,
    `${open} ${open === 1 ? 'bug is' : 'bugs are'} open and ${done} ${done === 1 ? 'is' : 'are'} fixed or verified.`,
  ]
  const topType = [...byType].sort((a, b) => b.value - a.value)[0]
  if (topType && topType.value > 0) {
    out.push(
      `The most common type is ${topType.label.toLowerCase()} (${plural(topType.value, 'bug')}).`,
    )
  }
  const always = valueOf(byReproducibility, 'ALWAYS')
  if (always > 0)
    out.push(`${Math.round(percent(always, total) * 100)}% of bugs reproduce every time.`)
  return out
}

export async function buildSummaryWorkbook(input: SummaryReportInput): Promise<Buffer> {
  const bySeverity = countsFromRecord(input.bugs.bySeverity, SEVERITY_ORDER)
  const byStatus = countsFromRecord(input.bugs.byStatus, STATUS_ORDER)
  const byType = countsFromRecord(input.bugs.byType, TYPE_ORDER)
  const byReproducibility = countsFromRecord(input.bugs.byReproducibility, REPRODUCIBILITY_ORDER)
  const total = input.bugs.total
  const severe = valueOf(bySeverity, 'CRITICAL') + valueOf(bySeverity, 'HIGH')
  const title = `Report ${input.kind.toLowerCase()}`

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Crowd4Test'
  wb.lastModifiedBy = 'Crowd4Test'
  wb.created = input.generatedAt
  wb.modified = input.generatedAt
  wb.title = title
  wb.company = 'Crowd4Test'

  const charts: ChartSpec[] = []

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = wb.addWorksheet(SHEETS.summary, {
    properties: { tabColor: { argb: argb(TEAL[500]) } },
  })
  paintCanvas(summary, [3, ...Array<number>(12).fill(13), 3])
  summary.getRow(1).height = 10
  let row = titleBlock(summary, {
    row: 2,
    fromCol: 2,
    toCol: 13,
    title,
    subtitle: clean(input.subtitle),
    note: `Prepared by Crowd4Test · Generated ${formatTime(input.generatedAt)}`,
  })
  row += 1

  const half = Math.ceil(input.facts.length / 2)
  input.facts.forEach(([label, value], i) => {
    const left = i < half
    pairRow(summary, {
      row: row + (left ? i : i - half),
      labelCol: left ? 2 : 8,
      labelSpan: 2,
      valueCol: left ? 4 : 10,
      valueSpan: 4,
      label,
      value,
    })
  })
  row += Math.max(half, 1) + 1

  sectionHeading(summary, row, 2, 13, 'Key figures')
  row += 2
  const figures: SummaryFigure[] = [
    ...input.figures,
    { label: 'Total bugs', value: total, note: 'Reported' },
    { label: 'Critical and high', value: severe, note: 'Severity critical or high' },
    { label: 'Open bugs', value: sumOf(byStatus, OPEN_STATUSES), note: 'New to reopened' },
    { label: 'Fixed or verified', value: sumOf(byStatus, DONE_STATUSES), note: 'Work completed' },
  ]
  for (let start = 0; start < figures.length; start += 6) {
    figures
      .slice(start, start + 6)
      .forEach((card, i) => kpiCard(summary, { row, col: 2 + i * 2, span: 2, ...card }))
    row += 4
  }

  sectionHeading(summary, row, 2, 13, 'Key findings')
  row += 1
  for (const line of findings(total, bySeverity, byStatus, byType, byReproducibility)) {
    paragraph(summary, { row, fromCol: 2, toCol: 13, text: line, charsPerLine: 125, bullet: true })
    row += 1
  }
  row += 1

  const described = (counts: readonly Count[]): string =>
    counts.map((c) => `${c.label} ${c.value}`).join(', ')

  const severityRow = row
  const severity = breakdown(summary, {
    sheetName: SHEETS.summary,
    row: severityRow,
    col: 2,
    heading: 'Bugs by severity',
    labelHeader: 'Severity',
    valueHeader: 'Bugs',
    items: toneItems(bySeverity, SEVERITY_TONE),
    showShare: true,
    kind: 'doughnut',
    chartTitle: 'Bugs by severity',
    chartDescription: `Doughnut chart of ${total} bugs by severity: ${described(bySeverity)}.`,
    chartFrom: { col: 5, row: severityRow - 1 },
    chartTo: { col: 13, row: severityRow + 11 },
  })
  if (severity.chart) charts.push(severity.chart)
  row = Math.max(severity.endRow, severityRow + 12) + 2
  paragraph(summary, {
    row,
    fromCol: 2,
    toCol: 13,
    text: `Open means new, triaged, confirmed, in progress or reopened. ${NOTE}`,
    charsPerLine: 150,
    size: 9,
    color: INK[600],
  })
  pageSetup(summary, title, 'portrait')

  // ── Analytics ──────────────────────────────────────────────────────────────
  const analytics = wb.addWorksheet(SHEETS.analytics, {
    properties: { tabColor: { argb: argb(TEAL[500]) } },
  })
  paintCanvas(analytics, [3, 34, 10, 10, 3, ...Array<number>(9).fill(10), 3])
  analytics.getRow(1).height = 10
  let at = titleBlock(analytics, {
    row: 2,
    fromCol: 2,
    toCol: 14,
    title: 'Bug analytics',
    subtitle: clean(input.subtitle),
    note: `${plural(total, 'bug')}. ${NOTE}`,
  })
  at += 1
  const block = (
    spec: Omit<
      Parameters<typeof breakdown>[1],
      'sheetName' | 'row' | 'col' | 'chartFrom' | 'chartTo'
    >,
  ): void => {
    const start = at
    const result = breakdown(analytics, {
      ...spec,
      sheetName: SHEETS.analytics,
      row: start,
      col: 2,
      chartFrom: { col: 5, row: start - 1 },
      chartTo: { col: 14, row: start + 13 },
    })
    if (result.chart) charts.push(result.chart)
    at = Math.max(result.endRow, start + 14) + 2
  }
  block({
    heading: 'Severity',
    labelHeader: 'Severity',
    valueHeader: 'Bugs',
    items: toneItems(bySeverity, SEVERITY_TONE),
    showShare: true,
    kind: 'doughnut',
    chartTitle: 'Bugs by severity',
    chartDescription: `Doughnut chart of bugs by severity: ${described(bySeverity)}.`,
  })
  block({
    heading: 'Status',
    labelHeader: 'Status',
    valueHeader: 'Bugs',
    items: toneItems(byStatus, STATUS_TONE),
    showShare: true,
    kind: 'bar',
    chartTitle: 'Bugs by status',
    chartDescription: `Bar chart of bugs by status: ${described(byStatus)}.`,
  })
  block({
    heading: 'Type',
    labelHeader: 'Type',
    valueHeader: 'Bugs',
    items: seriesItems(byType),
    showShare: true,
    kind: 'bar',
    chartTitle: 'Bugs by type',
    chartDescription: `Bar chart of bugs by type: ${described(byType)}.`,
  })
  block({
    heading: 'Reproducibility',
    labelHeader: 'How often it happens',
    valueHeader: 'Bugs',
    items: seriesItems(byReproducibility),
    showShare: true,
    kind: 'doughnut',
    chartTitle: 'Bugs by reproducibility',
    chartDescription: `Doughnut chart of bugs by how often they reproduce: ${described(byReproducibility)}.`,
  })
  for (const list of input.lists) {
    if (!list.chart || list.rows.length === 0) continue
    const { labelColumn, valueColumn } = list.chart
    const top = [...list.rows]
      .sort((a, b) => Number(b[valueColumn] ?? 0) - Number(a[valueColumn] ?? 0))
      .slice(0, 10)
    block({
      heading: list.heading,
      labelHeader: list.headers[labelColumn] ?? 'Name',
      valueHeader: list.chart.valueHeader,
      items: top.map((r, i) => ({
        label: String(r[labelColumn] ?? DASH),
        value: Number(r[valueColumn] ?? 0),
        color: SERIES[i % SERIES.length] ?? INK[500],
      })),
      showShare: true,
      kind: 'bar',
      chartTitle: list.chart.title,
      chartDescription: `Bar chart: ${list.chart.title}.`,
      footnote:
        list.rows.length > 10 ? 'The ten largest; the full list is on its own sheet.' : undefined,
    })
  }
  pageSetup(analytics, `${title} · analytics`, 'landscape')

  // ── Plain lists ────────────────────────────────────────────────────────────
  for (const list of input.lists) {
    const sheet = wb.addWorksheet(list.sheetName, {
      properties: { tabColor: { argb: argb(INK[700]) } },
    })
    sheet.views = [{ showGridLines: false }]
    titleBlock(sheet, { row: 1, fromCol: 1, toCol: 1, title: list.heading, note: NOTE })
    if (list.rows.length === 0) {
      sheet.getColumn(1).width = 28
      paragraph(sheet, {
        row: 4,
        fromCol: 1,
        toCol: 4,
        text: 'Nothing to list.',
        charsPerLine: 100,
      })
      continue
    }
    const columns: TableColumn<readonly (string | number)[]>[] = list.headers.map(
      (header, index) => ({
        header,
        width: list.numeric.includes(index) ? 14 : index === 0 ? 22 : 44,
        kind: list.numeric.includes(index) ? 'integer' : 'text',
        value: (r) => r[index] ?? DASH,
      }),
    )
    addDataTable(sheet, {
      name: list.sheetName.replace(/[^A-Za-z0-9]/g, ''),
      headerRow: 4,
      columns,
      rows: list.rows,
    })
    sheet.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }]
    pageSetup(sheet, `${title} · ${list.heading.toLowerCase()}`, 'landscape')
  }

  const raw = await wb.xlsx.writeBuffer()
  return addCharts(Buffer.from(raw), charts)
}

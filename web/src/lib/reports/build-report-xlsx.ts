import 'server-only'
import ExcelJS from 'exceljs'
import type { Worksheet } from 'exceljs'
import type { BuildReportData, ReportTestCase } from '@/lib/reports/build-report-data'
import {
  RESULT_ORDER,
  computeFacts,
  type Count,
  type ReportFacts,
} from '@/lib/reports/build-report-facts'
import { addCharts, type ChartSpec } from '@/lib/reports/xlsx-charts'
import {
  DASH,
  FORMAT,
  SHEET,
  addDataTable,
  breakdown,
  clean,
  countryName,
  fontOf,
  formatDay,
  formatTime,
  kpiCard,
  pageSetup,
  paintCanvas,
  pairRow,
  paragraph,
  parseDate,
  personName,
  plural,
  sectionHeading,
  sheetLink,
  textOrDash,
  titleBlock,
  titleCase,
  webLink,
  type BreakdownItem,
  type TableColumn,
} from '@/lib/reports/xlsx-kit'
import {
  INK,
  RESULT_TONE,
  SERIES,
  SEVERITY_TONE,
  STATUS_TONE,
  TEAL,
  argb,
} from '@/lib/reports/xlsx-palette'

/**
 * The per-build report as a client-ready Excel workbook.
 *
 * Key insights first (an executive summary, then the analytics), the detailed
 * records after. Every number is read from `BuildReportData`; a source that
 * could not be read is shown as unavailable rather than as zero, and a sheet
 * with nothing to say is left out rather than shown empty.
 *
 * ── WHAT IS DELIBERATELY NOT IN THE FILE
 *
 * Email addresses, phone numbers, signed attachment links and — for a
 * customer — anything the customer's own screens do not show. See
 * `build-report-data.ts`: the types it hands over cannot carry contact details.
 */

const FONT_NOTE = 'Times are UTC. A dash (—) means the value was not recorded; 0 is a real zero.'

interface Tone {
  fill: string
  text: string
  solid: string
}

/** Colour a column's cells by their value, so severity and status read at a glance. */
function colourByValue(
  sheet: Worksheet,
  range: string,
  tones: Record<string, Tone>,
  labelOf: (key: string) => string,
): void {
  sheet.addConditionalFormatting({
    ref: range,
    rules: Object.entries(tones).map(([key, tone], index) => ({
      type: 'cellIs' as const,
      operator: 'equal' as const,
      priority: index + 1,
      formulae: [`"${labelOf(key)}"`],
      style: {
        font: { bold: true, color: { argb: argb(tone.text) } },
        fill: {
          type: 'pattern' as const,
          pattern: 'solid' as const,
          bgColor: { argb: argb(tone.fill) },
        },
      },
    })),
  })
}

/** Greys out a dash, so a missing value recedes instead of looking like data. */
function greyDashes(sheet: Worksheet, range: string): void {
  sheet.addConditionalFormatting({
    ref: range,
    rules: [
      {
        type: 'cellIs',
        operator: 'equal',
        priority: 100,
        formulae: [`"${DASH}"`],
        style: { font: { color: { argb: argb(INK[400]) } } },
      },
    ],
  })
}

const toneItems = (
  counts: readonly Count[],
  tones: Record<string, Tone>,
  fallback: string,
): BreakdownItem[] =>
  counts.map((c) => ({ label: c.label, value: c.value, color: tones[c.key]?.solid ?? fallback }))

const seriesItems = (counts: readonly Count[]): BreakdownItem[] =>
  counts.map((c, i) => ({
    label: c.label,
    value: c.value,
    color: SERIES[i % SERIES.length] ?? INK[500],
  }))

/** The 10 biggest features, with everything below them folded into one honest line. */
function featureItems(facts: ReportFacts): BreakdownItem[] {
  const top = facts.byFeature.slice(0, 10)
  const rest = facts.byFeature.slice(10).reduce((sum, c) => sum + c.value, 0)
  const items = seriesItems(top)
  if (rest > 0) items.push({ label: 'All other features', value: rest, color: INK[300] })
  return items
}

interface ActivityRow {
  reference: string
  when: Date | null
  activity: string
  by: string
  what: string
  detail: string
  visibility: string
}

function activityRows(data: BuildReportData, facts: ReportFacts): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const bug of facts.bugs) {
    const detail = data.bugReport.details.get(bug.id)
    if (!detail) continue
    const bugRows: ActivityRow[] = []

    for (const h of detail.statusHistory) {
      bugRows.push({
        reference: bug.reference,
        when: parseDate(h.createdAt),
        activity: 'Status change',
        by: personName(h.changedBy),
        what: h.fromStatus
          ? `Changed from ${titleCase(h.fromStatus)} to ${titleCase(h.toStatus)}`
          : `Set to ${titleCase(h.toStatus)}`,
        detail: textOrDash(h.note),
        visibility: DASH,
      })
    }
    for (const c of detail.comments) {
      bugRows.push({
        reference: bug.reference,
        when: parseDate(c.createdAt),
        activity: 'Comment',
        by: c.author ? `${personName(c.author)} (${titleCase(c.author.role)})` : DASH,
        what: 'Comment posted',
        detail: textOrDash(c.body),
        visibility: c.isInternal ? 'Internal only' : 'Shared with client',
      })
    }
    for (const a of detail.attachments) {
      const kb = Math.max(1, Math.round(a.file.sizeBytes / 1024))
      bugRows.push({
        reference: bug.reference,
        when: parseDate(a.createdAt),
        activity: 'Attachment',
        by: DASH,
        what: `Added ${clean(a.file.originalName)} (${a.file.mimeType}, ${kb.toLocaleString('en-GB')} KB)${
          a.file.downloadUrl ? '' : ' — file no longer available'
        }`,
        detail: textOrDash(a.caption),
        visibility: DASH,
      })
    }
    bugRows.sort((x, y) => (x.when?.getTime() ?? 0) - (y.when?.getTime() ?? 0))
    rows.push(...bugRows)
  }
  return rows
}

interface FieldAnswerRow {
  reference: string
  field: string
  type: string
  answer: string
}

function fieldAnswers(facts: ReportFacts): FieldAnswerRow[] {
  return facts.bugs.flatMap((bug) =>
    (bug.customValues ?? []).map((v) => ({
      reference: bug.reference,
      field: clean(v.field.name),
      type: titleCase(v.field.type),
      // Checkbox answers are stored newline-joined; one line reads better in a cell.
      answer: textOrDash(v.value.split(/\r?\n/).filter(Boolean).join('; ')),
    })),
  )
}

const joined = (values: readonly string[]): string => (values.length > 0 ? values.join('; ') : DASH)

// ── Executive summary ────────────────────────────────────────────────────────

function summarySheet(
  wb: ExcelJS.Workbook,
  data: BuildReportData,
  facts: ReportFacts,
  contents: readonly { name: string; description: string }[],
  charts: ChartSpec[],
): void {
  const sheet = wb.addWorksheet(SHEET.summary, {
    properties: { tabColor: { argb: argb(TEAL[500]) } },
  })
  paintCanvas(sheet, [3, ...Array<number>(12).fill(13), 3])
  const { project, build, summary } = data

  sheet.getRow(1).height = 10
  let row = titleBlock(sheet, {
    row: 2,
    fromCol: 2,
    toCol: 13,
    title: 'Build report',
    subtitle: `${project.reference} · ${clean(project.title)}`,
    note: `Prepared by Crowd4Test · Generated ${formatTime(data.generatedAt)}`,
  })
  row += 1

  const start = parseDate(build?.startDate ?? project.startDate)
  const end = parseDate(build?.endDate ?? project.endDate)
  const period =
    start && end
      ? `${formatDay(start)} – ${formatDay(end)}`
      : start
        ? `From ${formatDay(start)}`
        : end
          ? `Until ${formatDay(end)}`
          : 'Not scheduled'

  const left: [string, string][] = [
    ['Organisation', clean(project.organisation.name)],
    ['Project', clean(project.title)],
    ['Project status', titleCase(project.status)],
    ['Priority', titleCase(project.priority)],
  ]
  const right: [string, string][] = [
    ['Build', build ? clean(build.name) : DASH],
    ['Build status', build ? titleCase(build.status) : DASH],
    ['Test type', build?.testType ? titleCase(build.testType) : DASH],
    ['Test period', period],
  ]
  left.forEach(([label, value], i) => {
    pairRow(sheet, {
      row: row + i,
      labelCol: 2,
      labelSpan: 2,
      valueCol: 4,
      valueSpan: 4,
      label,
      value,
    })
    const [rl, rv] = right[i] ?? ['', '']
    pairRow(sheet, {
      row: row + i,
      labelCol: 8,
      labelSpan: 2,
      valueCol: 10,
      valueSpan: 4,
      label: rl,
      value: rv,
    })
  })
  row += left.length + 1

  sectionHeading(sheet, row, 2, 13, 'Key figures')
  row += 2

  const testers = summary?.testerCount ?? data.testers.length
  const completion = summary
    ? summary.testCaseCompletion === null
      ? { value: 'Not applicable', note: 'No test cases' }
      : {
          value: summary.testCaseCompletion / 100,
          note: 'Reports filed ÷ test cases',
          format: FORMAT.percent,
        }
    : { value: 'Unavailable', note: 'Could not be read' }

  const cards = [
    { label: 'Total bugs', value: facts.total, note: 'Reported on this build' },
    { label: 'Critical and high', value: facts.criticalAndHigh, note: 'Severity critical or high' },
    { label: 'Open bugs', value: facts.open, note: 'New to reopened' },
    { label: 'Fixed or verified', value: facts.done, note: 'Work completed' },
    {
      label: 'Testers',
      value: testers,
      note: summary ? 'Accepted, active or completed' : 'Invited to this build',
    },
    {
      label: 'Test case completion',
      value: completion.value,
      note: completion.note,
      format: 'format' in completion ? completion.format : undefined,
    },
  ]
  cards.forEach((card, i) => kpiCard(sheet, { row, col: 2 + i * 2, span: 2, ...card }))
  row += 4

  const featuresWithBugs = facts.byFeature.filter((c) => c.key !== 'No feature set').length
  const second = [
    {
      label: 'Test cases',
      value: summary ? summary.testCaseCount : (build?._count.testCases ?? 'Unavailable'),
      note: 'Set up for this build',
    },
    {
      label: 'Reviews',
      value: summary ? summary.reviewCount : 'Unavailable',
      note: 'Tester reviews given',
    },
    {
      label: 'Average rating',
      value: summary ? (summary.averageRating ?? 'No reviews') : 'Unavailable',
      note: 'Out of 5',
      format: summary?.averageRating != null ? FORMAT.decimalOne : undefined,
    },
    {
      label: 'Features with bugs',
      value: featuresWithBugs,
      note: 'Features a bug is filed against',
    },
    {
      label: 'Duplicate or rejected',
      value: facts.duplicatesAndRejected,
      note: 'Not counted as defects',
    },
    { label: 'Attachments', value: facts.attachments, note: 'Files attached to bugs' },
  ]
  second.forEach((card, i) => kpiCard(sheet, { row, col: 2 + i * 2, span: 2, ...card }))
  row += 4

  sectionHeading(sheet, row, 2, 13, 'Key findings')
  row += 1
  for (const finding of facts.findings) {
    paragraph(sheet, { row, fromCol: 2, toCol: 13, text: finding, charsPerLine: 125, bullet: true })
    row += 1
  }
  row += 1

  const severityRow = row
  const severity = breakdown(sheet, {
    sheetName: SHEET.summary,
    row: severityRow,
    col: 2,
    heading: 'Bugs by severity',
    labelHeader: 'Severity',
    valueHeader: 'Bugs',
    items: toneItems(facts.bySeverity, SEVERITY_TONE, INK[500]),
    showShare: true,
    kind: 'doughnut',
    chartTitle: 'Bugs by severity',
    chartDescription: `Doughnut chart of ${facts.total} bugs by severity: ${facts.bySeverity.map((c) => `${c.label} ${c.value}`).join(', ')}.`,
    chartFrom: { col: 5, row: severityRow - 1 },
    chartTo: { col: 13, row: severityRow + 11 },
  })
  if (severity.chart) charts.push(severity.chart)
  row = Math.max(severity.endRow, severityRow + 12) + 2

  sectionHeading(sheet, row, 2, 13, 'In this workbook')
  row += 1
  for (const entry of contents) {
    const label = sheet.getCell(row, 2)
    sheet.mergeCells(row, 2, row, 4)
    label.value = sheetLink(entry.name)
    label.font = fontOf({ bold: true, underline: true, color: TEAL[600] })
    sheet.mergeCells(row, 5, row, 13)
    const note = sheet.getCell(row, 5)
    note.value = entry.description
    note.font = fontOf({ color: INK[700] })
    note.alignment = { wrapText: true, vertical: 'top' }
    row += 1
  }
  row += 1
  paragraph(sheet, {
    row,
    fromCol: 2,
    toCol: 13,
    text: `Open means new, triaged, confirmed, in progress or reopened. ${FONT_NOTE}`,
    charsPerLine: 150,
    size: 9,
    color: INK[600],
  })
  pageSetup(sheet, `${data.project.reference} · build report`, 'portrait')
}

// ── Bug analytics ────────────────────────────────────────────────────────────

function analyticsSheet(
  wb: ExcelJS.Workbook,
  data: BuildReportData,
  facts: ReportFacts,
  charts: ChartSpec[],
): void {
  const sheet = wb.addWorksheet(SHEET.analytics, {
    properties: { tabColor: { argb: argb(TEAL[500]) } },
  })
  paintCanvas(sheet, [3, 34, 10, 10, 3, ...Array<number>(9).fill(10), 3])
  sheet.getRow(1).height = 10
  let row = titleBlock(sheet, {
    row: 2,
    fromCol: 2,
    toCol: 14,
    title: 'Bug analytics',
    subtitle: `${data.project.reference} · ${data.build ? clean(data.build.name) : ''}`.replace(
      / · $/,
      '',
    ),
    note: `${plural(facts.total, 'bug')} on this build. ${FONT_NOTE}`,
  })
  row += 1

  /** One block: the table on the left, its chart on the right, then room before the next. */
  const block = (
    spec: Omit<
      Parameters<typeof breakdown>[1],
      'sheetName' | 'row' | 'col' | 'chartFrom' | 'chartTo'
    >,
  ): void => {
    const start = row
    const result = breakdown(sheet, {
      ...spec,
      sheetName: SHEET.analytics,
      row: start,
      col: 2,
      chartFrom: { col: 5, row: start - 1 },
      chartTo: { col: 14, row: start + 13 },
    })
    if (result.chart) charts.push(result.chart)
    row = Math.max(result.endRow, start + 14) + 2
  }

  const described = (counts: readonly Count[]) =>
    counts.map((c) => `${c.label} ${c.value}`).join(', ')

  block({
    heading: 'Severity',
    labelHeader: 'Severity',
    valueHeader: 'Bugs',
    items: toneItems(facts.bySeverity, SEVERITY_TONE, INK[500]),
    showShare: true,
    kind: 'doughnut',
    chartTitle: 'Bugs by severity',
    chartDescription: `Doughnut chart of bugs by severity: ${described(facts.bySeverity)}.`,
  })
  block({
    heading: 'Status',
    labelHeader: 'Status',
    valueHeader: 'Bugs',
    items: toneItems(facts.byStatus, STATUS_TONE, INK[500]),
    showShare: true,
    kind: 'bar',
    chartTitle: 'Bugs by status',
    chartDescription: `Bar chart of bugs by status: ${described(facts.byStatus)}.`,
  })
  block({
    heading: 'Type',
    labelHeader: 'Type',
    valueHeader: 'Bugs',
    items: seriesItems(facts.byType),
    showShare: true,
    kind: 'bar',
    chartTitle: 'Bugs by type',
    chartDescription: `Bar chart of bugs by type: ${described(facts.byType)}.`,
    footnote: 'Bugs filed without a type are counted as "Not specified".',
  })
  block({
    heading: 'Reproducibility',
    labelHeader: 'How often it happens',
    valueHeader: 'Bugs',
    items: seriesItems(facts.byReproducibility),
    showShare: true,
    kind: 'doughnut',
    chartTitle: 'Bugs by reproducibility',
    chartDescription: `Doughnut chart of bugs by how often they reproduce: ${described(facts.byReproducibility)}.`,
  })
  if (facts.byFeature.length > 0) {
    block({
      heading: 'Features',
      labelHeader: 'Feature',
      valueHeader: 'Bugs',
      items: featureItems(facts),
      showShare: true,
      kind: 'bar',
      chartTitle: 'Bugs by feature',
      chartDescription: `Bar chart of the features with the most bugs. The largest is ${facts.byFeature[0]?.label ?? 'none'} with ${facts.byFeature[0]?.value ?? 0}.`,
      footnote: 'The ten features with the most bugs; the rest are combined.',
    })
  }
  if (facts.trend.points.length > 1) {
    const unit = facts.trend.unit
    block({
      heading: 'Bugs over time',
      labelHeader: unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month',
      valueHeader: 'Bugs reported',
      items: facts.trend.points.map((p) => ({ label: p.label, value: p.value, color: TEAL[500] })),
      kind: 'line',
      chartTitle: `Bugs reported per ${unit}`,
      chartDescription: `Line chart of bugs reported per ${unit}, from ${facts.trend.points[0]?.label ?? ''} to ${facts.trend.points.at(-1)?.label ?? ''}.`,
      footnote: 'Periods with no bugs are shown as 0.',
    })
  }
  pageSetup(sheet, `${data.project.reference} · bug analytics`, 'landscape')
}

// ── Detailed bug report ──────────────────────────────────────────────────────

function bugsSheet(wb: ExcelJS.Workbook, data: BuildReportData, facts: ReportFacts): void {
  const sheet = wb.addWorksheet(SHEET.bugs, { properties: { tabColor: { argb: argb(INK[700]) } } })
  sheet.views = [{ showGridLines: false }]
  titleBlock(sheet, {
    row: 1,
    fromCol: 1,
    toCol: 1,
    title: 'Detailed bug report',
    note: `One row per bug, with everything recorded about it. ${FONT_NOTE}`,
  })

  if (facts.total === 0) {
    sheet.getColumn(1).width = 28
    paragraph(sheet, {
      row: 4,
      fromCol: 1,
      toCol: 6,
      text: 'No bugs have been reported on this build.',
      charsPerLine: 100,
    })
    pageSetup(sheet, `${data.project.reference} · detailed bug report`, 'landscape')
    return
  }

  const date = (value: string | null): Date | string => parseDate(value) ?? DASH
  const os = (b: (typeof facts.bugs)[number]): string =>
    [b.osName, b.osVersion].filter(Boolean).join(' ') || DASH

  const columns: TableColumn<(typeof facts.bugs)[number]>[] = [
    { header: 'Bug ID', width: 14, value: (b) => b.reference },
    { header: 'Title', width: 38, kind: 'long', value: (b) => textOrDash(b.title) },
    { header: 'Severity', width: 12, value: (b) => titleCase(b.severity) },
    { header: 'Status', width: 15, value: (b) => titleCase(b.status) },
    { header: 'Type', width: 14, value: (b) => (b.type ? titleCase(b.type) : DASH) },
    { header: 'Reproducibility', width: 18, value: (b) => titleCase(b.reproducibility) },
    {
      header: 'Times seen / attempts',
      width: 14,
      value: (b) =>
        b.occurrence !== null && b.outOf !== null ? `${b.occurrence} of ${b.outOf}` : DASH,
    },
    { header: 'Feature', width: 22, kind: 'long', value: (b) => b.feature?.name ?? DASH },
    { header: 'Reported by', width: 22, value: (b) => personName(b.reportedBy) },
    {
      header: 'Reporter country',
      width: 16,
      value: (b) => countryName(b.reportedBy?.testerProfile?.countryCode),
    },
    { header: 'Description', width: 52, kind: 'long', value: (b) => textOrDash(b.description) },
    { header: 'Pre-conditions', width: 34, kind: 'long', value: (b) => textOrDash(b.preCondition) },
    {
      header: 'Steps to reproduce',
      width: 52,
      kind: 'long',
      value: (b) => textOrDash(b.stepsToReproduce),
    },
    {
      header: 'Expected result',
      width: 36,
      kind: 'long',
      value: (b) => textOrDash(b.expectedResult),
    },
    { header: 'Actual result', width: 36, kind: 'long', value: (b) => textOrDash(b.actualResult) },
    { header: 'Device', width: 20, value: (b) => textOrDash(b.deviceModel) },
    { header: 'Operating system', width: 18, value: os },
    { header: 'Browser', width: 18, value: (b) => textOrDash(b.browser) },
    { header: 'App version', width: 14, value: (b) => textOrDash(b.appVersion) },
    { header: 'Network', width: 12, value: (b) => textOrDash(b.networkType) },
    { header: 'Video link', width: 32, kind: 'link', value: (b) => webLink(b.videoUrl) as never },
    {
      header: 'Duplicate of',
      width: 14,
      value: (b) =>
        data.bugReport.details.get(b.id)?.duplicateOf?.reference ??
        (b.duplicateOfId ? 'Unavailable' : DASH),
    },
    { header: 'Attachments', width: 12, kind: 'integer', value: (b) => b._count.attachments },
    { header: 'Comments', width: 11, kind: 'integer', value: (b) => b._count.comments },
    {
      header: 'Reported on',
      width: 18,
      kind: 'datetime',
      value: (b) => date(b.createdAt),
    },
    { header: 'Triaged on', width: 18, kind: 'datetime', value: (b) => date(b.triagedAt) },
    {
      header: 'Resolved on',
      width: 18,
      kind: 'datetime',
      value: (b) => date(b.resolvedAt),
    },
    {
      header: 'Last updated',
      width: 18,
      kind: 'datetime',
      value: (b) => date(b.updatedAt),
    },
  ]

  const headerRow = 4
  const { lastRow } = addDataTable(sheet, {
    name: 'DetailedBugs',
    headerRow,
    columns,
    rows: facts.bugs,
  })
  const first = headerRow + 1
  colourByValue(sheet, `C${first}:C${lastRow}`, SEVERITY_TONE, titleCase)
  colourByValue(sheet, `D${first}:D${lastRow}`, STATUS_TONE, titleCase)
  const lastCol = columns.length
  greyDashes(sheet, `A${first}:${columnName(lastCol)}${lastRow}`)

  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: headerRow, showGridLines: false }]
  if (data.bugReport.incomplete.length > 0) {
    sheet.getCell(3, 1).value =
      `Comments, history and attachment details could not be loaded for ${plural(data.bugReport.incomplete.length, 'bug')}: ${data.bugReport.incomplete.join(', ')}.`
    sheet.getCell(3, 1).font = fontOf({ size: 9, italic: true, color: INK[600] })
  }
  pageSetup(sheet, `${data.project.reference} · detailed bug report`, 'landscape')
}

/** 1 → A, 27 → AA. */
function columnName(n: number): string {
  let out = ''
  let rest = n
  while (rest > 0) {
    out = String.fromCharCode(65 + ((rest - 1) % 26)) + out
    rest = Math.floor((rest - 1) / 26)
  }
  return out
}

// ── Tester summary ───────────────────────────────────────────────────────────

function testersSheet(wb: ExcelJS.Workbook, data: BuildReportData, charts: ChartSpec[]): void {
  const sheet = wb.addWorksheet(SHEET.testers, {
    properties: { tabColor: { argb: argb(INK[700]) } },
  })
  sheet.views = [{ showGridLines: false }]
  const admin = data.audience === 'admin'
  const testers = data.testers

  titleBlock(sheet, {
    row: 1,
    fromCol: 1,
    toCol: 1,
    title: 'Tester summary',
    note: `${plural(testers.length, 'tester')} invited to this build. Names only — no contact details. ${FONT_NOTE}`,
  })

  if (testers.length === 0) {
    sheet.getColumn(1).width = 28
    paragraph(sheet, {
      row: 4,
      fromCol: 1,
      toCol: 6,
      text: 'No testers have been invited to this build.',
      charsPerLine: 100,
    })
    pageSetup(sheet, `${data.project.reference} · tester summary`, 'landscape')
    return
  }

  // Test reports filed per tester, when the test cases could be read.
  const filed = new Map<string, number>()
  for (const testCase of data.testCases ?? []) {
    for (const report of testCase.reports)
      filed.set(report.tester.id, (filed.get(report.tester.id) ?? 0) + 1)
  }

  const statusCounts = new Map<string, number>()
  for (const t of testers) statusCounts.set(t.status, (statusCounts.get(t.status) ?? 0) + 1)
  const statusOrder = ['INVITED', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'DECLINED', 'REMOVED']
  const items: BreakdownItem[] = [
    ...statusOrder,
    ...[...statusCounts.keys()].filter((k) => !statusOrder.includes(k)),
  ]
    .filter((key) => (statusCounts.get(key) ?? 0) > 0)
    .map((key, i) => ({
      label: titleCase(key),
      value: statusCounts.get(key) ?? 0,
      color: SERIES[i % SERIES.length] ?? INK[500],
    }))

  const glanceRow = 4
  const glance = breakdown(sheet, {
    sheetName: SHEET.testers,
    row: glanceRow,
    col: 1,
    heading: 'Participation',
    labelHeader: 'Status',
    valueHeader: 'Testers',
    items,
    showShare: true,
    kind: 'bar',
    chartTitle: 'Testers by participation status',
    chartDescription: `Bar chart of testers by status: ${items.map((i) => `${i.label} ${i.value}`).join(', ')}.`,
    chartFrom: { col: 4, row: glanceRow - 1 },
    chartTo: { col: 9, row: glanceRow + 11 },
  })
  if (glance.chart) charts.push(glance.chart)

  const device = (t: (typeof testers)[number]): string =>
    t.assignedDevice
      ? [t.assignedDevice.manufacturer, t.assignedDevice.model].filter(Boolean).join(' ') ||
        titleCase(t.assignedDevice.type)
      : DASH
  const browser = (t: (typeof testers)[number]): string =>
    t.assignedBrowser
      ? [t.assignedBrowser.browser.name, t.assignedBrowser.browserVersion?.version]
          .filter(Boolean)
          .join(' ')
      : DASH

  const rating = (t: (typeof testers)[number]): number | string => {
    const value = t.tester.testerProfile?.ratingAverage
    if (value === null || value === undefined || value === '') return DASH
    const n = Number(value)
    return Number.isFinite(n) ? n : DASH
  }

  const columns: TableColumn<(typeof testers)[number]>[] = [
    { header: 'Tester', width: 28, value: (t) => personName(t.tester) },
    { header: 'Participation status', width: 20, value: (t) => titleCase(t.status) },
    {
      header: 'Country',
      width: 18,
      value: (t) => countryName(t.tester.testerProfile?.countryCode),
    },
    {
      header: 'Average rating (out of 5)',
      width: 16,
      kind: 'decimal',
      value: (t) => rating(t),
    },
    {
      header: 'Invited on',
      width: 18,
      kind: 'date',
      value: (t) => parseDate(t.invitedAt) ?? DASH,
    },
    {
      header: 'Responded on',
      width: 18,
      kind: 'date',
      value: (t) => parseDate(t.respondedAt) ?? DASH,
    },
    {
      header: 'Completed on',
      width: 18,
      kind: 'date',
      value: (t) => parseDate(t.completedAt) ?? DASH,
    },
    ...(admin
      ? [
          { header: 'Assigned device', width: 24, value: device },
          { header: 'Assigned browser', width: 22, value: browser },
        ]
      : []),
    {
      header: 'Test reports filed',
      width: 14,
      kind: 'integer',
      value: (t) => (data.testCases === null ? 'Unavailable' : (filed.get(t.tester.id) ?? 0)),
    },
  ]

  const headerRow = Math.max(glance.endRow, glanceRow + 12) + 2
  const sorted = [...testers].sort((a, b) =>
    personName(a.tester).localeCompare(personName(b.tester)),
  )
  const { firstRow, lastRow } = addDataTable(sheet, {
    name: 'Testers',
    headerRow,
    columns,
    rows: sorted,
  })
  greyDashes(sheet, `A${firstRow}:${columnName(columns.length)}${lastRow}`)
  pageSetup(sheet, `${data.project.reference} · tester summary`, 'landscape')
}

// ── Test results ─────────────────────────────────────────────────────────────

interface ResultRow {
  feature: string
  testCase: string
  expected: string
  result: string
  tester: string
  devices: string
  browsers: string
  notes: string
  bug: string
  when: Date | string
}

function resultRows(testCases: readonly ReportTestCase[]): ResultRow[] {
  const rows: ResultRow[] = []
  const sorted = [...testCases].sort(
    (a, b) =>
      (a.feature ?? '').localeCompare(b.feature ?? '') ||
      a.title.localeCompare(b.title, 'en', { numeric: true }),
  )
  for (const tc of sorted) {
    const base = {
      feature: tc.feature ?? DASH,
      testCase: textOrDash(tc.title),
      expected: textOrDash(tc.expectedResult),
    }
    if (tc.reports.length === 0) {
      rows.push({
        ...base,
        result: 'Not tested',
        tester: DASH,
        devices: DASH,
        browsers: DASH,
        notes: DASH,
        bug: DASH,
        when: DASH,
      })
      continue
    }
    for (const r of [...tc.reports].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      rows.push({
        ...base,
        result: titleCase(r.result),
        tester: personName(r.tester),
        devices: textOrDash(r.devices),
        browsers: textOrDash(r.browsers),
        notes: textOrDash(r.notes),
        bug: r.linkedBug?.reference ?? DASH,
        when: parseDate(r.createdAt) ?? DASH,
      })
    }
  }
  return rows
}

function testsSheet(wb: ExcelJS.Workbook, data: BuildReportData, charts: ChartSpec[]): void {
  const sheet = wb.addWorksheet(SHEET.tests, { properties: { tabColor: { argb: argb(INK[700]) } } })
  sheet.views = [{ showGridLines: false }]
  const { summary, testCases } = data

  titleBlock(sheet, {
    row: 1,
    fromCol: 1,
    toCol: 1,
    title: 'Test results',
    note: `How the build's test cases were executed. ${FONT_NOTE}`,
  })

  // The platform's own tally when it has one; otherwise counted from the cases themselves.
  const counted = new Map<string, number>()
  for (const tc of testCases ?? [])
    for (const r of tc.reports) counted.set(r.result, (counted.get(r.result) ?? 0) + 1)
  const byResult = summary?.testReportsByResult ?? Object.fromEntries(counted)
  const items: BreakdownItem[] = [
    ...RESULT_ORDER,
    ...Object.keys(byResult).filter((k) => !(RESULT_ORDER as readonly string[]).includes(k)),
  ].map((key) => ({
    label: titleCase(key),
    value: byResult[key] ?? 0,
    color: RESULT_TONE[key]?.solid ?? INK[500],
  }))

  sheet.getColumn(1).width = 30
  sheet.getColumn(2).width = 34
  const caseCount = summary?.testCaseCount ?? testCases?.length
  const lines = [
    caseCount === undefined
      ? 'Test cases: unavailable.'
      : `Test cases: ${caseCount.toLocaleString('en-GB')}.`,
    summary
      ? summary.testCaseCompletion === null
        ? 'Completion: not applicable, because there are no test cases.'
        : `Completion: ${summary.testCaseCompletion}% (test reports filed ÷ test cases).`
      : 'Completion: unavailable.',
  ]
  lines.forEach((text, i) =>
    paragraph(sheet, { row: 3 + i, fromCol: 1, toCol: 3, text, charsPerLine: 90 }),
  )

  const glanceRow = 6
  const glance = breakdown(sheet, {
    sheetName: SHEET.tests,
    row: glanceRow,
    col: 1,
    heading: 'Results',
    labelHeader: 'Result',
    valueHeader: 'Test reports',
    items,
    showShare: true,
    kind: 'doughnut',
    chartTitle: 'Test reports by result',
    chartDescription: `Doughnut chart of test reports by result: ${items.map((i) => `${i.label} ${i.value}`).join(', ')}.`,
    chartFrom: { col: 4, row: glanceRow - 1 },
    chartTo: { col: 9, row: glanceRow + 11 },
  })
  if (glance.chart) charts.push(glance.chart)

  let row = Math.max(glance.endRow, glanceRow + 12) + 2
  if (testCases === null) {
    paragraph(sheet, {
      row,
      fromCol: 1,
      toCol: 6,
      text: 'The individual test cases could not be loaded, so only the totals above are shown.',
      charsPerLine: 100,
      color: INK[600],
    })
  } else if (testCases.length === 0) {
    paragraph(sheet, {
      row,
      fromCol: 1,
      toCol: 6,
      text: 'No test cases were set up for this build.',
      charsPerLine: 100,
    })
  } else {
    const rows = resultRows(testCases)
    const columns: TableColumn<ResultRow>[] = [
      { header: 'Feature', width: 30, kind: 'long', value: (r) => r.feature },
      { header: 'Test case', width: 34, kind: 'long', value: (r) => r.testCase },
      { header: 'Expected result', width: 36, kind: 'long', value: (r) => r.expected },
      { header: 'Result', width: 14, value: (r) => r.result },
      { header: 'Tested by', width: 22, value: (r) => r.tester },
      { header: 'Devices', width: 22, kind: 'long', value: (r) => r.devices },
      { header: 'Browsers', width: 22, kind: 'long', value: (r) => r.browsers },
      { header: 'Notes', width: 40, kind: 'long', value: (r) => r.notes },
      { header: 'Bug raised', width: 14, value: (r) => r.bug },
      { header: 'Tested on', width: 18, kind: 'datetime', value: (r) => r.when },
    ]
    sectionHeading(sheet, row, 1, 4, 'Test cases and their reports')
    row += 1
    const { firstRow, lastRow } = addDataTable(sheet, {
      name: 'TestResults',
      headerRow: row,
      columns,
      rows,
    })
    colourByValue(sheet, `D${firstRow}:D${lastRow}`, RESULT_TONE, titleCase)
    greyDashes(sheet, `A${firstRow}:${columnName(columns.length)}${lastRow}`)
  }
  pageSetup(sheet, `${data.project.reference} · test results`, 'landscape')
}

// ── Bug history & comments ───────────────────────────────────────────────────

function historySheet(
  wb: ExcelJS.Workbook,
  data: BuildReportData,
  rows: readonly ActivityRow[],
): void {
  const sheet = wb.addWorksheet(SHEET.history, {
    properties: { tabColor: { argb: argb(INK[700]) } },
  })
  sheet.views = [{ showGridLines: false }]
  titleBlock(sheet, {
    row: 1,
    fromCol: 1,
    toCol: 1,
    title: 'Bug history & comments',
    note: `Every status change, comment and attachment, grouped by bug and in the order it happened. ${FONT_NOTE}`,
  })
  const { incomplete } = data.bugReport
  if (incomplete.length > 0) {
    sheet.getCell(3, 1).value =
      `History could not be loaded for ${plural(incomplete.length, 'bug')}: ${incomplete.join(', ')}.`
    sheet.getCell(3, 1).font = fontOf({ size: 9, italic: true, color: INK[600] })
  }

  if (rows.length === 0) {
    sheet.getColumn(1).width = 28
    paragraph(sheet, {
      row: 5,
      fromCol: 1,
      toCol: 6,
      text: 'No status changes, comments or attachments were recorded.',
      charsPerLine: 100,
    })
    pageSetup(sheet, `${data.project.reference} · bug history`, 'landscape')
    return
  }

  const columns: TableColumn<ActivityRow>[] = [
    { header: 'Bug ID', width: 14, value: (r) => r.reference },
    { header: 'When', width: 18, kind: 'datetime', value: (r) => r.when ?? DASH },
    { header: 'Activity', width: 16, value: (r) => r.activity },
    { header: 'By', width: 28, value: (r) => r.by },
    { header: 'What happened', width: 48, kind: 'long', value: (r) => r.what },
    { header: 'Comment or note', width: 64, kind: 'long', value: (r) => r.detail },
    { header: 'Visible to client', width: 18, value: (r) => r.visibility },
  ]
  const headerRow = 5
  const { firstRow, lastRow } = addDataTable(sheet, {
    name: 'BugActivity',
    headerRow,
    columns,
    rows,
  })
  greyDashes(sheet, `A${firstRow}:${columnName(columns.length)}${lastRow}`)
  sheet.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }]
  pageSetup(sheet, `${data.project.reference} · bug history`, 'landscape')
}

function fieldsSheet(
  wb: ExcelJS.Workbook,
  data: BuildReportData,
  rows: readonly FieldAnswerRow[],
): void {
  const sheet = wb.addWorksheet(SHEET.fields, {
    properties: { tabColor: { argb: argb(INK[700]) } },
  })
  sheet.views = [{ showGridLines: false }]
  titleBlock(sheet, {
    row: 1,
    fromCol: 1,
    toCol: 1,
    title: 'Custom field answers',
    note: `The extra questions this project asks on every bug, and the answers given. ${FONT_NOTE}`,
  })
  const columns: TableColumn<FieldAnswerRow>[] = [
    { header: 'Bug ID', width: 14, value: (r) => r.reference },
    { header: 'Question', width: 36, kind: 'long', value: (r) => r.field },
    { header: 'Answer type', width: 18, value: (r) => r.type },
    { header: 'Answer', width: 60, kind: 'long', value: (r) => r.answer },
  ]
  const { firstRow, lastRow } = addDataTable(sheet, {
    name: 'CustomAnswers',
    headerRow: 4,
    columns,
    rows,
  })
  greyDashes(sheet, `A${firstRow}:D${lastRow}`)
  sheet.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }]
  pageSetup(sheet, `${data.project.reference} · custom field answers`, 'landscape')
}

// ── Project & build details ──────────────────────────────────────────────────

function buildSheet(wb: ExcelJS.Workbook, data: BuildReportData): void {
  const sheet = wb.addWorksheet(SHEET.build, { properties: { tabColor: { argb: argb(INK[700]) } } })
  paintCanvas(sheet, [32, 46, 32, 26, 20])
  const { project, build } = data

  let row = titleBlock(sheet, {
    row: 1,
    fromCol: 1,
    toCol: 1,
    title: 'Project & build details',
    note: `How the project and this build were set up. ${FONT_NOTE}`,
  })
  row += 1

  const dateOrDash = (value: string | null | undefined, withTime = false): string => {
    const date = parseDate(value)
    return date ? (withTime ? formatTime(date) : formatDay(date)) : DASH
  }

  const keyValues = (
    heading: string,
    pairs: readonly (readonly [string, string | { text: string; hyperlink: string }])[],
  ): void => {
    sectionHeading(sheet, row, 1, 5, heading)
    row += 1
    for (const [label, value] of pairs) {
      const l = sheet.getCell(row, 1)
      l.value = label
      l.font = fontOf({ size: 9, color: INK[600] })
      l.alignment = { vertical: 'top' }
      sheet.mergeCells(row, 2, row, 5)
      const v = sheet.getCell(row, 2)
      v.value = value
      v.font =
        typeof value === 'string' ? fontOf({}) : fontOf({ underline: true, color: TEAL[600] })
      v.alignment = { vertical: 'top', wrapText: true, horizontal: 'left' }
      const length = typeof value === 'string' ? value.length : value.text.length
      const newlines = typeof value === 'string' ? (value.match(/\n/g)?.length ?? 0) : 0
      sheet.getRow(row).height = Math.max(16, (Math.ceil(length / 105) + newlines) * 14 + 4)
      for (let c = 1; c <= 5; c += 1)
        sheet.getCell(row, c).border = {
          bottom: { style: 'thin', color: { argb: argb(INK[200]) } },
        }
      row += 1
    }
    row += 1
  }

  keyValues('Project', [
    ['Reference', project.reference],
    ['Title', textOrDash(project.title)],
    ['Organisation', textOrDash(project.organisation.name)],
    ['Status', titleCase(project.status)],
    ['Priority', titleCase(project.priority)],
    ['Summary', textOrDash(project.summary)],
    ['Progress', `${project.progressPercent}%`],
    ['Start date', dateOrDash(project.startDate)],
    ['End date', dateOrDash(project.endDate)],
    ['Platforms', joined(project.platformTargets.map(titleCase))],
    ['Target countries', joined(project.targetCountries.map(countryName))],
    ['Target languages', joined(project.targetLanguages)],
    ['Maximum testers', project.maxTesters === null ? 'No limit set' : String(project.maxTesters)],
    ['Created', dateOrDash(project.createdAt, true)],
  ])

  if (build) {
    const link = webLink(build.appUrl)
    keyValues('Build', [
      ['Name', clean(build.name)],
      ['Default build', build.isDefault ? 'Yes' : 'No'],
      ['Status', titleCase(build.status)],
      ['Test type', build.testType ? titleCase(build.testType) : DASH],
      ['Description', textOrDash(build.description)],
      ['App link', link],
      ['Release notes', textOrDash(build.releaseNotes)],
      ['Instructions for testers', textOrDash(build.instructions)],
      ['Special requirements', textOrDash(build.specialRequirements)],
      [
        'Test plan document',
        build.testDocument ? clean(build.testDocument.originalName) : 'None attached',
      ],
      ['Start date', dateOrDash(build.startDate)],
      ['End date', dateOrDash(build.endDate)],
      ['Maximum testers', build.maxTesters === null ? 'No limit set' : String(build.maxTesters)],
      ['Testers invited', String(build._count.assignments)],
      ['Test cases', String(build._count.testCases)],
      ['Bugs', String(build._count.bugs)],
      ['Created', dateOrDash(build.createdAt, true)],
      ['Last updated', dateOrDash(build.updatedAt, true)],
    ])
    keyValues('Test targets', [
      ['Devices', joined(build.targetDevices)],
      ['Browsers', joined(build.targetBrowsers)],
      ['Operating systems', joined(build.targetOperatingSystems)],
      ['Countries', joined(build.targetCountries.map(countryName))],
      ['Languages', joined(build.targetLanguages)],
    ])
  } else {
    keyValues('Build', [['Details', 'The build details could not be loaded.']])
  }

  sectionHeading(sheet, row, 1, 5, `Materials (${data.materials.length})`)
  row += 1
  if (data.materials.length === 0) {
    paragraph(sheet, {
      row,
      fromCol: 1,
      toCol: 5,
      text: 'No materials were added to this build.',
      charsPerLine: 120,
      color: INK[600],
    })
    row += 2
  } else {
    const columns: TableColumn<(typeof data.materials)[number]>[] = [
      { header: 'Title', width: 32, kind: 'long', value: (m) => textOrDash(m.title) },
      { header: 'Description', width: 46, kind: 'long', value: (m) => textOrDash(m.description) },
      { header: 'Link', width: 32, kind: 'link', value: (m) => webLink(m.url) as never },
      {
        header: 'File',
        width: 26,
        kind: 'long',
        value: (m) => (m.file ? clean(m.file.originalName) : DASH),
      },
      {
        header: 'Added on',
        width: 20,
        kind: 'date',
        value: (m) => parseDate(m.createdAt) ?? DASH,
      },
    ]
    const { lastRow } = addDataTable(sheet, {
      name: 'Materials',
      headerRow: row,
      columns,
      rows: data.materials,
    })
    row = lastRow + 2
  }

  const features = data.features
  sectionHeading(sheet, row, 1, 5, features === null ? 'Features' : `Features (${features.length})`)
  row += 1
  if (features === null) {
    paragraph(sheet, {
      row,
      fromCol: 1,
      toCol: 5,
      text: 'The feature list could not be loaded.',
      charsPerLine: 120,
      color: INK[600],
    })
  } else if (features.length === 0) {
    paragraph(sheet, {
      row,
      fromCol: 1,
      toCol: 5,
      text: 'No features were defined for this build.',
      charsPerLine: 120,
      color: INK[600],
    })
  } else {
    const columns: TableColumn<(typeof features)[number]>[] = [
      { header: 'Feature', width: 32, kind: 'long', value: (f) => textOrDash(f.name) },
      { header: 'Bugs filed against it', width: 46, kind: 'integer', value: (f) => f._count.bugs },
      {
        header: 'Added on',
        width: 32,
        kind: 'date',
        value: (f) => parseDate(f.createdAt) ?? DASH,
      },
    ]
    addDataTable(sheet, { name: 'Features', headerRow: row, columns, rows: features })
  }
  pageSetup(sheet, `${data.project.reference} · project & build details`, 'portrait')
}

// ── The workbook ─────────────────────────────────────────────────────────────

/** Builds the report and returns the finished `.xlsx` file. */
export async function buildReportWorkbook(data: BuildReportData): Promise<Buffer> {
  const facts = computeFacts(data)
  const activity = activityRows(data, facts)
  const answers = fieldAnswers(facts)

  const hasTests =
    (data.summary?.testCaseCount ?? 0) > 0 ||
    (data.testCases?.length ?? 0) > 0 ||
    data.testCases === null
  const hasHistory = activity.length > 0 || data.bugReport.incomplete.length > 0

  const contents: { name: string; description: string }[] = [
    {
      name: SHEET.analytics,
      description:
        'Severity, status, type and reproducibility, bugs by feature and bugs over time.',
    },
    { name: SHEET.bugs, description: `${plural(facts.total, 'bug')} with their full details.` },
    {
      name: SHEET.testers,
      description: `${plural(data.testers.length, 'tester')}, with participation, country and rating.`,
    },
    ...(hasTests
      ? [{ name: SHEET.tests, description: 'Test case execution results and completion.' }]
      : []),
    ...(hasHistory
      ? [
          {
            name: SHEET.history,
            description: `${plural(activity.length, 'status change, comment or attachment', 'status changes, comments and attachments')}.`,
          },
        ]
      : []),
    ...(answers.length > 0
      ? [
          {
            name: SHEET.fields,
            description: `${plural(answers.length, 'answer')} to this project's custom bug questions.`,
          },
        ]
      : []),
    {
      name: SHEET.build,
      description: 'How the project and the build were set up, with materials and features.',
    },
  ]

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Crowd4Test'
  wb.lastModifiedBy = 'Crowd4Test'
  wb.created = data.generatedAt
  wb.modified = data.generatedAt
  wb.title = `Build report — ${data.project.reference}`
  wb.subject = clean(data.project.title)
  wb.company = 'Crowd4Test'

  const charts: ChartSpec[] = []
  summarySheet(wb, data, facts, contents, charts)
  analyticsSheet(wb, data, facts, charts)
  bugsSheet(wb, data, facts)
  testersSheet(wb, data, charts)
  if (hasTests) testsSheet(wb, data, charts)
  if (hasHistory) historySheet(wb, data, activity)
  if (answers.length > 0) fieldsSheet(wb, data, answers)
  buildSheet(wb, data)

  const raw = await wb.xlsx.writeBuffer()
  return addCharts(Buffer.from(raw), charts)
}

/** `P-0042-build-1-report.xlsx` — letters, digits and dashes only. */
export function reportFilename(data: BuildReportData): string {
  const slug = (value: string): string =>
    value
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  return `${slug(data.project.reference)}-${slug(data.build?.name ?? 'build')}-report.xlsx`
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

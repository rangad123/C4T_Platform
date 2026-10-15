import 'server-only'
import JSZip from 'jszip'
import { FONT, INK } from '@/lib/reports/xlsx-palette'

/**
 * Native Excel charts, added to a workbook ExcelJS has already written.
 *
 * ExcelJS writes cells, styles, tables and conditional formats but has no
 * chart support. A chart is only a few XML parts, so this adds them to the
 * finished file: a chart part per chart, a drawing part per sheet that anchors
 * them, and the relationships and content types that tie them together.
 *
 * Every chart is "live" in the way Excel understands it: its series point at
 * cell ranges on a sheet (`'Bug analytics'!$B$6:$B$9`), and the values Excel
 * would otherwise recalculate are also cached in the chart, so viewers that do
 * not recalculate (previewers, phones) still draw it. Edit a cell and the chart
 * follows in Excel.
 */

export type ChartKind = 'bar' | 'column' | 'doughnut' | 'line'

/** A rectangle of cells, 1-based, in one column. */
export interface ColumnRange {
  sheet: string
  column: number
  firstRow: number
  lastRow: number
}

export interface ChartSpec {
  /** The sheet the chart is drawn on. */
  sheet: string
  kind: ChartKind
  title: string
  /** Read aloud by assistive tech. */
  description: string
  categories: ColumnRange
  values: ColumnRange
  /** Cell holding the series name (the value column's header). */
  seriesName: { sheet: string; column: number; row: number; text: string }
  /** The cached labels and numbers — must match what the ranges hold. */
  categoryLabels: readonly string[]
  valueNumbers: readonly number[]
  /** One colour per point (bar, column, doughnut), six-digit RGB. A line uses the first. */
  colors: readonly string[]
  /** Zero-based top-left and bottom-right cell the chart covers. */
  from: { col: number; row: number }
  to: { col: number; row: number }
}

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const REL_DRAWING = `${NS_R}/drawing`
const REL_CHART = `${NS_R}/chart`
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/** 1 → A, 27 → AA. */
function columnLetter(column: number): string {
  let n = column
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const sheetRef = (name: string): string => `'${name.replace(/'/g, "''")}'`

function rangeFormula(range: ColumnRange): string {
  const col = columnLetter(range.column)
  return `${sheetRef(range.sheet)}!$${col}$${range.firstRow}:$${col}$${range.lastRow}`
}

const solid = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

/** Text properties: one size, one colour, the workbook's font. */
function textProps(size: number, colour: string, bold = false): string {
  return (
    '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>' +
    `<a:defRPr sz="${size}" b="${bold ? 1 : 0}">${solid(colour)}<a:latin typeface="${FONT}"/></a:defRPr>` +
    '</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>'
  )
}

function titleXml(text: string): string {
  return (
    '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>' +
    `<a:defRPr sz="1200" b="1">${solid(INK[900])}<a:latin typeface="${FONT}"/></a:defRPr></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="1200" b="1">${solid(INK[900])}<a:latin typeface="${FONT}"/></a:rPr>` +
    `<a:t>${escapeXml(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
  )
}

function stringCache(labels: readonly string[]): string {
  return (
    `<c:strCache><c:ptCount val="${labels.length}"/>` +
    labels.map((l, i) => `<c:pt idx="${i}"><c:v>${escapeXml(l)}</c:v></c:pt>`).join('') +
    '</c:strCache>'
  )
}

function numberCache(values: readonly number[]): string {
  return (
    `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>` +
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('') +
    '</c:numCache>'
  )
}

function seriesCore(spec: ChartSpec): { name: string; categories: string; values: string } {
  const name = `<c:tx><c:strRef><c:f>${escapeXml(
    `${sheetRef(spec.seriesName.sheet)}!$${columnLetter(spec.seriesName.column)}$${spec.seriesName.row}`,
  )}</c:f>${stringCache([spec.seriesName.text])}</c:strRef></c:tx>`
  const categories = `<c:cat><c:strRef><c:f>${escapeXml(rangeFormula(spec.categories))}</c:f>${stringCache(spec.categoryLabels)}</c:strRef></c:cat>`
  const values = `<c:val><c:numRef><c:f>${escapeXml(rangeFormula(spec.values))}</c:f>${numberCache(spec.valueNumbers)}</c:numRef></c:val>`
  return { name, categories, values }
}

function pointColour(spec: ChartSpec, index: number): string {
  return spec.colors[index % spec.colors.length] ?? INK[500]
}

/** The per-point fills that give each bar or slice its own colour. */
function dataPoints(spec: ChartSpec, bar: boolean): string {
  return spec.valueNumbers
    .map(
      (_, i) =>
        `<c:dPt><c:idx val="${i}"/>${bar ? '<c:invertIfNegative val="0"/>' : ''}<c:bubble3D val="0"/>` +
        `<c:spPr>${solid(pointColour(spec, i))}<a:ln w="12700">${solid(INK[50])}</a:ln></c:spPr></c:dPt>`,
    )
    .join('')
}

const noLine = '<a:ln><a:noFill/></a:ln>'

function dataLabels(position: string | null): string {
  return (
    `<c:dLbls><c:spPr><a:noFill/>${noLine}</c:spPr>${textProps(900, INK[700], true)}` +
    (position ? `<c:dLblPos val="${position}"/>` : '') +
    '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>' +
    '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>'
  )
}

const axisLine = `<c:spPr><a:ln w="9525">${solid(INK[300])}</a:ln></c:spPr>`

function categoryAxis(id: number, crossId: number, horizontal: boolean): string {
  return (
    `<c:catAx><c:axId val="${id}"/>` +
    // A horizontal bar chart draws its first category at the bottom; reversing it
    // makes the table order and the chart order read the same way.
    `<c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/>` +
    '<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/>' +
    `<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axisLine}${textProps(900, INK[700])}` +
    `<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/><c:auto val="1"/>` +
    '<c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
  )
}

function valueAxis(id: number, crossId: number, horizontal: boolean): string {
  return (
    `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>` +
    `<c:majorGridlines><c:spPr><a:ln w="6350">${solid(INK[200])}</a:ln></c:spPr></c:majorGridlines>` +
    '<c:numFmt formatCode="0" sourceLinked="0"/><c:majorTickMark val="none"/>' +
    `<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr>${noLine}</c:spPr>` +
    `${textProps(900, INK[600])}<c:crossAx val="${crossId}"/>` +
    // With the categories reversed the value axis would jump to the top; crossing at
    // the maximum keeps it along the bottom.
    `<c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`
  )
}

function plotArea(spec: ChartSpec): string {
  const { name, categories, values } = seriesCore(spec)
  const catId = 50010
  const valId = 50020

  if (spec.kind === 'doughnut') {
    return (
      '<c:plotArea><c:layout/><c:doughnutChart><c:varyColors val="1"/>' +
      `<c:ser><c:idx val="0"/><c:order val="0"/>${name}${dataPoints(spec, false)}${dataLabels(null)}${categories}${values}</c:ser>` +
      '<c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart></c:plotArea>'
    )
  }

  if (spec.kind === 'line') {
    const colour = pointColour(spec, 0)
    return (
      '<c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' +
      `<c:ser><c:idx val="0"/><c:order val="0"/>${name}` +
      `<c:spPr><a:ln w="28575" cap="rnd">${solid(colour)}<a:round/></a:ln></c:spPr>` +
      `<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${solid(colour)}<a:ln w="9525">${solid(INK[50])}</a:ln></c:spPr></c:marker>` +
      `${dataLabels('t')}${categories}${values}<c:smooth val="0"/></c:ser>` +
      `<c:marker val="1"/><c:axId val="${catId}"/><c:axId val="${valId}"/></c:lineChart>` +
      `${categoryAxis(catId, valId, false)}${valueAxis(valId, catId, false)}</c:plotArea>`
    )
  }

  const horizontal = spec.kind === 'bar'
  return (
    `<c:plotArea><c:layout/><c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/>` +
    '<c:grouping val="clustered"/><c:varyColors val="0"/>' +
    `<c:ser><c:idx val="0"/><c:order val="0"/>${name}` +
    `<c:spPr>${solid(pointColour(spec, 0))}</c:spPr><c:invertIfNegative val="0"/>` +
    `${dataPoints(spec, true)}${dataLabels('outEnd')}${categories}${values}</c:ser>` +
    `<c:gapWidth val="55"/><c:axId val="${catId}"/><c:axId val="${valId}"/></c:barChart>` +
    `${categoryAxis(catId, valId, horizontal)}${valueAxis(valId, catId, horizontal)}</c:plotArea>`
  )
}

export function chartXml(spec: ChartSpec): string {
  const legend =
    spec.kind === 'doughnut'
      ? `<c:legend><c:legendPos val="r"/><c:overlay val="0"/>${textProps(900, INK[700])}</c:legend>`
      : ''
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    '<c:date1904 val="0"/><c:roundedCorners val="0"/>' +
    `<c:chart>${titleXml(spec.title)}<c:autoTitleDeleted val="0"/>${plotArea(spec)}${legend}` +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    `<c:spPr>${solid(INK[50])}<a:ln w="9525">${solid(INK[200])}</a:ln></c:spPr>` +
    `${textProps(900, INK[700])}</c:chartSpace>`
  )
}

function anchorXml(spec: ChartSpec, relId: string, shapeId: number): string {
  const cell = (point: { col: number; row: number }) =>
    `<xdr:col>${point.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${point.row}</xdr:row><xdr:rowOff>0</xdr:rowOff>`
  return (
    '<xdr:twoCellAnchor editAs="oneCell">' +
    `<xdr:from>${cell(spec.from)}</xdr:from><xdr:to>${cell(spec.to)}</xdr:to>` +
    '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>' +
    `<xdr:cNvPr id="${shapeId}" name="Chart ${shapeId - 1}" title="${escapeXml(spec.title)}" descr="${escapeXml(spec.description)}"/>` +
    '<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${relId}"/></a:graphicData></a:graphic>` +
    '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>'
  )
}

const relationshipsXml = (items: readonly { id: string; type: string; target: string }[]): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  items.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('') +
  '</Relationships>'

/** `xl/worksheets/sheet3.xml` for a sheet name, by way of the workbook's own rels. */
async function sheetPaths(zip: JSZip): Promise<Map<string, string>> {
  const workbook = await zip.file('xl/workbook.xml')?.async('string')
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!workbook || !rels) throw new Error('The workbook is missing its sheet list')

  const targets = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1]
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1]
    if (id && target) targets.set(id, target)
  }

  const out = new Map<string, string>()
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1]
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1]
    const target = rid ? targets.get(rid) : undefined
    if (!name || !target) continue
    const unescaped = name
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
    out.set(unescaped, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }
  return out
}

/**
 * Where `<drawing>` belongs in a worksheet: before the parts the schema puts
 * after it, otherwise at the very end.
 */
function insertDrawing(sheetXml: string, relId: string): string {
  const tag = `<drawing r:id="${relId}"/>`
  for (const marker of [
    '<legacyDrawing',
    '<legacyDrawingHF',
    '<picture',
    '<oleObjects',
    '<controls',
    '<webPublishItems',
    '<tableParts',
    '<extLst',
    '</worksheet>',
  ]) {
    const at = sheetXml.indexOf(marker)
    if (at !== -1) return sheetXml.slice(0, at) + tag + sheetXml.slice(at)
  }
  return sheetXml
}

/** Adds every chart to the workbook and returns the new file. */
export async function addCharts(workbook: Buffer, charts: readonly ChartSpec[]): Promise<Buffer> {
  if (charts.length === 0) return workbook
  const zip = await JSZip.loadAsync(workbook)
  const paths = await sheetPaths(zip)

  const bySheet = new Map<string, ChartSpec[]>()
  for (const chart of charts) {
    bySheet.set(chart.sheet, [...(bySheet.get(chart.sheet) ?? []), chart])
  }

  let contentTypes = await zip.file('[Content_Types].xml')!.async('string')
  const overrides: string[] = []
  let chartNumber = 0
  let drawingNumber = 0

  for (const [sheetName, sheetCharts] of bySheet) {
    const sheetPath = paths.get(sheetName)
    if (!sheetPath) throw new Error(`Cannot find the sheet "${sheetName}" to draw charts on`)
    drawingNumber += 1

    const anchors: string[] = []
    const drawingRels: { id: string; type: string; target: string }[] = []
    sheetCharts.forEach((chart, index) => {
      chartNumber += 1
      const relId = `rId${index + 1}`
      zip.file(`xl/charts/chart${chartNumber}.xml`, chartXml(chart))
      drawingRels.push({ id: relId, type: REL_CHART, target: `../charts/chart${chartNumber}.xml` })
      anchors.push(anchorXml(chart, relId, index + 2))
      overrides.push(
        `<Override PartName="/xl/charts/chart${chartNumber}.xml" ContentType="${CT_CHART}"/>`,
      )
    })

    zip.file(
      `xl/drawings/drawing${drawingNumber}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${anchors.join('')}</xdr:wsDr>`,
    )
    zip.file(`xl/drawings/_rels/drawing${drawingNumber}.xml.rels`, relationshipsXml(drawingRels))
    overrides.push(
      `<Override PartName="/xl/drawings/drawing${drawingNumber}.xml" ContentType="${CT_DRAWING}"/>`,
    )

    // Tie the drawing to its sheet.
    const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'))
    const sheetFile = sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
    const relsPath = `${sheetDir}/_rels/${sheetFile}.rels`
    const drawingRelId = `rIdDrawing${drawingNumber}`
    const drawingRel = `<Relationship Id="${drawingRelId}" Type="${REL_DRAWING}" Target="../drawings/drawing${drawingNumber}.xml"/>`
    const existing = await zip.file(relsPath)?.async('string')
    zip.file(
      relsPath,
      existing
        ? existing.replace('</Relationships>', `${drawingRel}</Relationships>`)
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRel}</Relationships>`,
    )

    const sheetXml = await zip.file(sheetPath)!.async('string')
    zip.file(sheetPath, insertDrawing(sheetXml, drawingRelId))
  }

  contentTypes = contentTypes.replace('</Types>', `${overrides.join('')}</Types>`)
  zip.file('[Content_Types].xml', contentTypes)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

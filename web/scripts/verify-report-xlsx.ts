/**
 * Builds the per-build report workbook from a fixture and checks the file,
 * not just the code that wrote it.
 *
 *   npm run verify:report
 *
 * What it proves, for both the admin and the customer version:
 *   - the file is a real workbook: every XML part parses, and ExcelJS (an
 *     independent reader) opens it with the sheets, tables and values expected;
 *   - every chart is wired up — drawing, relationship and content type — and
 *     its cell ranges hold exactly the labels and numbers cached in the chart;
 *   - the numbers match the fixture (totals, severity, status, reproducibility);
 *   - nothing sensitive leaks: the fixture's people carry emails and phone
 *     numbers on the wire, and none may appear anywhere in the file;
 *   - the customer's file omits the columns the customer's screens do not show;
 *   - empty and missing data degrade to a stated absence, not a crash or a zero.
 *
 * Runs under the `react-server` condition so the `server-only` imports resolve
 * outside Next (see the npm script).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { SaxesParser } from 'saxes'
import type { BugReportRow } from '../src/lib/reports/bug-report-data'
import type { BuildReportData } from '../src/lib/reports/build-report-data'
import { buildReportWorkbook, reportFilename } from '../src/lib/reports/build-report-xlsx'

/** A cell value as text — objects (formulas, links) as JSON rather than "[object Object]". */
const show = (value: unknown): string =>
  typeof value === 'object' && value !== null
    ? JSON.stringify(value)
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : ''

let failures = 0
const check = (condition: boolean, message: string): void => {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${message}`)
  if (!condition) failures += 1
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const SECRET_EMAIL = 'secret.person@example.invalid'
const SECRET_PHONE = '+91 98765 43210'

const person = (id: string, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
  // On the wire for an admin session; the report must never write either.
  email: SECRET_EMAIL,
  phone: SECRET_PHONE,
})

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const STATUSES = [
  'NEW',
  'TRIAGED',
  'CONFIRMED',
  'IN_PROGRESS',
  'FIXED',
  'VERIFIED',
  'REJECTED',
  'DUPLICATE',
] as const
const TYPES = ['CRASH', 'FUNCTIONAL', 'UI', 'UX', 'PERFORMANCE', null] as const
const REPRO = ['ALWAYS', 'SOMETIMES', 'ONCE', 'RARELY'] as const
const FEATURES = ['Checkout', 'Sign in', 'Search', 'Profile & settings', 'Notifications', 'Reports']

function bugs(count: number): BugReportRow[] {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(2026, 8, 1 + (i % 40), 9 + (i % 8), 15))
    return {
      id: `bug-${i}`,
      reference: `C4T-000${100 + i}`,
      // Hostile on purpose: a formula, a control character, an ampersand.
      title:
        i === 0 ? '=HYPERLINK("http://example.invalid","click")' : `Bug ${i} \u0007 & more <b>`,
      description: `Description ${i}\nwith a second line`,
      preCondition: i % 3 === 0 ? null : 'Signed in',
      stepsToReproduce: '1. Open the app\n2. Tap the button\n3. Observe',
      expectedResult: i % 4 === 0 ? null : 'It works',
      actualResult: 'It does not',
      severity: SEVERITIES[i % 4]!,
      status: STATUSES[i % STATUSES.length]!,
      reproducibility: REPRO[i % REPRO.length]!,
      occurrence: i % 2 === 0 ? 3 : null,
      outOf: i % 2 === 0 ? 5 : null,
      videoUrl: i % 5 === 0 ? 'https://example.invalid/video' : null,
      type: TYPES[i % TYPES.length]!,
      feature: i % 7 === 6 ? null : { name: FEATURES[i % FEATURES.length]! },
      deviceModel: 'Pixel 7a',
      osName: 'Android',
      osVersion: '14',
      browser: 'Chrome 126',
      appVersion: '2.4.1',
      networkType: 'Wi-Fi',
      duplicateOfId: null,
      triagedAt: day.toISOString(),
      resolvedAt: i % 3 === 0 ? day.toISOString() : null,
      createdAt: day.toISOString(),
      updatedAt: day.toISOString(),
      build: { name: 'Build 1' },
      reportedBy: {
        ...person(`t${i % 5}`, 'Tester', `Number${i % 5}`),
        testerProfile: { countryCode: i % 2 ? 'IN' : 'US' },
      },
      customValues:
        i % 6 === 0 ? [{ value: 'a\nb', field: { name: 'Region', type: 'CHECKBOX' } }] : [],
      _count: { attachments: i % 3, comments: i % 2 },
    }
  })
}

function fixture(audience: 'admin' | 'customer', bugCount = 36): BuildReportData {
  const list = bugs(bugCount)
  const details = new Map(
    list.map((bug, i) => [
      bug.id,
      {
        duplicateOf: null,
        attachments:
          i % 3 === 0
            ? []
            : [
                {
                  caption: 'Screenshot',
                  createdAt: bug.createdAt,
                  file: {
                    originalName: 'shot.png',
                    mimeType: 'image/png',
                    sizeBytes: 204800,
                    downloadUrl: 'https://signed.example.invalid/secret-token',
                  },
                },
              ],
        comments:
          i % 2 === 0
            ? []
            : [
                {
                  body: 'Reproduced on a second device.',
                  isInternal: audience === 'admin' && i % 4 === 1,
                  createdAt: bug.createdAt,
                  author: { ...person('a1', 'Alex', 'Admin'), role: 'ADMIN' },
                },
              ],
        statusHistory: [
          {
            fromStatus: 'NEW',
            toStatus: bug.status,
            note: 'Triaged by the team',
            createdAt: bug.updatedAt,
            changedBy: person('a1', 'Alex', 'Admin'),
          },
        ],
      },
    ]),
  )
  return {
    audience,
    generatedAt: new Date(Date.UTC(2026, 9, 15, 10, 30)),
    project: {
      reference: 'C4T-LEG-000467',
      title: 'Acme mobile app',
      summary: 'Regression test of the checkout flow.',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      platformTargets: ['ANDROID', 'IOS'],
      targetCountries: ['IN', 'US'],
      targetLanguages: ['English'],
      maxTesters: 10,
      startDate: '2026-09-01T00:00:00.000Z',
      endDate: '2026-10-10T00:00:00.000Z',
      progressPercent: 60,
      createdAt: '2026-08-25T00:00:00.000Z',
      organisation: { name: 'Acme & Sons' },
    },
    build: {
      name: 'Build 1',
      isDefault: true,
      status: 'TESTED',
      testType: 'REGRESSION',
      description: 'First build',
      appUrl: 'https://example.invalid/app',
      releaseNotes: null,
      instructions: 'Test the checkout.',
      specialRequirements: null,
      targetDevices: ['Pixel 7a', 'iPhone 15'],
      targetBrowsers: ['Chrome'],
      targetOperatingSystems: ['Android 14'],
      targetCountries: ['IN'],
      targetLanguages: ['English'],
      maxTesters: 10,
      startDate: '2026-09-01T00:00:00.000Z',
      endDate: '2026-10-10T00:00:00.000Z',
      testDocument: { originalName: 'plan.pdf' },
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      _count: {
        assignments: 5,
        bugs: bugCount,
        materials: 1,
        features: FEATURES.length,
        testCases: 3,
      },
    },
    summary: {
      testerCount: 4,
      bugCount,
      testCaseCount: 3,
      testCaseCompletion: 67,
      testReportsByResult: { PASS: 2, FAIL: 1, BLOCKED: 0, NOT_TESTED: 0 },
      reviewCount: 2,
      averageRating: 4.5,
    },
    features: FEATURES.map((name) => ({
      name,
      createdAt: '2026-08-26T00:00:00.000Z',
      _count: { bugs: 3 },
    })),
    testers: Array.from({ length: 5 }, (_, i) => ({
      status: ['INVITED', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'DECLINED'][i]!,
      invitedAt: '2026-08-28T00:00:00.000Z',
      respondedAt: i === 0 ? null : '2026-08-29T00:00:00.000Z',
      completedAt: i === 3 ? '2026-10-01T00:00:00.000Z' : null,
      // The API may send these to a customer; the customer file must still leave them out.
      assignedDevice: {
        type: 'MOBILE',
        manufacturer: 'Google',
        model: 'Pixel 7a',
        osName: 'Android',
      },
      assignedBrowser: { browser: { name: 'Chrome' }, browserVersion: { version: '126' } },
      tester: {
        ...person(`t${i}`, 'Tester', `Number${i}`),
        testerProfile: { ratingAverage: i === 4 ? null : '4.25', countryCode: i % 2 ? 'IN' : 'US' },
      },
    })),
    materials: [
      {
        title: 'Test plan',
        description: null,
        url: 'https://example.invalid/plan',
        createdAt: '2026-08-27T00:00:00.000Z',
        file: null,
      },
    ],
    testCases: [
      {
        id: 'tc1',
        feature: 'Checkout',
        title: 'Pay by card',
        expectedResult: 'Order placed',
        createdAt: '2026-08-27T00:00:00.000Z',
        assignments: [],
        reports: [
          {
            id: 'r1',
            result: 'PASS',
            notes: 'Fine',
            devices: 'Pixel 7a',
            browsers: null,
            createdAt: '2026-09-05T00:00:00.000Z',
            tester: person('t1', 'Tester', 'Number1'),
            linkedBug: null,
          },
        ],
      },
      {
        id: 'tc2',
        feature: 'Sign in',
        title: 'Wrong password',
        expectedResult: 'Error shown',
        createdAt: '2026-08-27T00:00:00.000Z',
        assignments: [],
        reports: [
          {
            id: 'r2',
            result: 'FAIL',
            notes: null,
            devices: null,
            browsers: 'Chrome',
            createdAt: '2026-09-06T00:00:00.000Z',
            tester: person('t2', 'Tester', 'Number2'),
            linkedBug: { reference: 'C4T-000101' },
          },
        ],
      },
      {
        id: 'tc3',
        feature: null,
        title: 'Offline mode',
        expectedResult: 'Cached data',
        createdAt: '2026-08-27T00:00:00.000Z',
        assignments: [],
        reports: [],
      },
    ],
    bugReport: { bugs: list, details, incomplete: [] },
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

/** Throws on the first malformed byte — every part of the file must be well-formed XML. */
function assertWellFormed(xml: string, name: string): void {
  const parser = new SaxesParser({ xmlns: true })
  let error: Error | null = null
  parser.on('error', (e) => {
    error ??= e
  })
  parser.write(xml).close()
  if (error) throw new Error(`${name}: ${(error as Error).message}`)
}

async function inspect(label: string, data: BuildReportData): Promise<void> {
  console.log(`\n${label}`)
  const file = await buildReportWorkbook(data)
  const out = join(tmpdir(), 'c4t-report-check')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${label.toLowerCase().replace(/\W+/g, '-')}.xlsx`), file)

  check(file.length > 5_000, `file is ${file.length.toLocaleString('en-GB')} bytes`)
  check(reportFilename(data).endsWith('-report.xlsx'), `filename ${reportFilename(data)}`)

  // 1 · The package is sound.
  const zip = await JSZip.loadAsync(file)
  const parts = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir)
  let allParse = true
  for (const name of parts.filter((n) => /\.(xml|rels)$/.test(n))) {
    try {
      assertWellFormed(await zip.file(name)!.async('string'), name)
    } catch (e) {
      allParse = false
      console.log(`        ${(e as Error).message}`)
    }
  }
  check(allParse, `all ${parts.length} XML parts are well-formed`)

  const types = await zip.file('[Content_Types].xml')!.async('string')
  const chartParts = parts.filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))
  const drawingParts = parts.filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))
  check(
    chartParts.length >= 6,
    `${chartParts.length} charts and ${drawingParts.length} drawings written`,
  )
  check(
    chartParts.every((n) => types.includes(`PartName="/${n}"`)) &&
      drawingParts.every((n) => types.includes(`PartName="/${n}"`)),
    'every chart and drawing is registered in [Content_Types].xml',
  )

  // 2 · An independent reader opens it.
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(file as never)
  const names = book.worksheets.map((s) => s.name)
  console.log(`        sheets: ${names.join(' | ')}`)
  for (const expected of [
    'Executive summary',
    'Bug analytics',
    'Detailed bug report',
    'Tester summary',
    'Test results',
    'Bug history & comments',
    'Custom field answers',
    'Project & build details',
  ]) {
    check(names.includes(expected), `sheet "${expected}" present`)
  }
  check(names[0] === 'Executive summary' && names[1] === 'Bug analytics', 'key insights come first')

  // 3 · Each chart's ranges hold exactly what the chart caches.
  const sheetsWithCharts = new Set<string>()
  for (const part of chartParts) {
    const xml = await zip.file(part)!.async('string')
    const ranges = [
      ...xml.matchAll(
        /<c:(cat|val)><c:(?:str|num)Ref><c:f>([^<]+)<\/c:f>(.*?)<\/c:(?:str|num)Ref>/g,
      ),
    ]
    let matched = ranges.length === 2
    for (const [, , ref, cache] of ranges) {
      const m = /^'(.+)'!\$([A-Z]+)\$(\d+):\$[A-Z]+\$(\d+)$/.exec(
        ref!.replace(/&amp;/g, '&').replace(/''/g, "'"),
      )
      if (!m) {
        matched = false
        continue
      }
      sheetsWithCharts.add(m[1]!)
      const sheet = book.getWorksheet(m[1])
      const cached = [...cache!.matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((x) =>
        x[1]!.replace(/&amp;/g, '&'),
      )
      const actual: string[] = []
      for (let r = Number(m[3]); r <= Number(m[4]); r += 1)
        actual.push(show(sheet?.getCell(`${m[2]}${r}`).value))
      if (JSON.stringify(cached) !== JSON.stringify(actual)) {
        matched = false
        console.log(
          `        ${part}: cached ${JSON.stringify(cached)} != cells ${JSON.stringify(actual)}`,
        )
      }
    }
    check(matched, `${part}: its ranges hold the cached labels and numbers`)
  }
  check(sheetsWithCharts.size >= 3, `charts live on ${[...sheetsWithCharts].join(', ')}`)

  // 4 · The numbers are the fixture's.
  const detail = book.getWorksheet('Detailed bug report')!
  const header = detail.getRow(4).values as unknown[]
  const col = (name: string): number => header.indexOf(name)
  let bodyRows = 0
  for (let r = 5; r <= detail.rowCount; r += 1) if (detail.getCell(r, 1).value) bodyRows += 1
  check(
    bodyRows === data.bugReport.bugs.length,
    `detailed sheet lists all ${bodyRows} of ${data.bugReport.bugs.length} bugs`,
  )
  check(show(detail.getCell(5, 1).value) === 'C4T-000100', 'bugs are in reference order')
  check(
    show(detail.getCell(5, col('Title')).value).startsWith('='),
    'a title starting "=" is kept as text, not run as a formula',
  )
  check(
    !JSON.stringify(detail.getCell(5, col('Title')).value).includes('\u0007'),
    'control characters are stripped',
  )
  check(detail.getCell(6, col('Reported on')).value instanceof Date, 'dates are real Excel dates')
  check(
    detail.getCell(5, col('Pre-conditions')).value === '—',
    'a missing value is a dash, not blank or zero',
  )
  check(detail.getCell(5, col('Attachments')).value === 0, 'a real zero stays a zero')
  check(detail.views[0]?.state === 'frozen', 'header row is frozen')
  check(
    Object.keys((detail as unknown as { tables: Record<string, unknown> }).tables).length === 1,
    'the bugs are an Excel table (filters, banding)',
  )

  const analytics = book.getWorksheet('Bug analytics')!
  const find = (heading: string): number => {
    for (let r = 1; r <= analytics.rowCount; r += 1)
      if (analytics.getCell(r, 2).value === heading) return r
    return -1
  }
  const severityRow = find('Severity')
  const sev = SEVERITIES.map((_, i) => Number(analytics.getCell(severityRow + 2 + i, 3).value))
  const expected = SEVERITIES.map((s) => data.bugReport.bugs.filter((b) => b.severity === s).length)
  check(
    JSON.stringify(sev) === JSON.stringify(expected),
    `severity counts ${sev.join('/')} match the bugs ${expected.join('/')}`,
  )
  check(
    sev.reduce((a, b) => a + b, 0) === data.bugReport.bugs.length,
    'severity counts add up to the total',
  )

  const summary = book.getWorksheet('Executive summary')!
  const texts: string[] = []
  summary.eachRow((row) => row.eachCell((cell) => texts.push(show(cell.value))))
  check(
    texts.some((t) => t.includes(`${data.bugReport.bugs.length} bugs were reported`)),
    'executive summary states the bug total',
  )
  check(
    texts.some((t) => t.includes('Acme & Sons')),
    'organisation name is on the summary',
  )

  const testers = book.getWorksheet('Tester summary')!
  let testerHeader: string[] = []
  testers.eachRow((row) => {
    const v = row.values as unknown[]
    if (v.includes('Participation status')) testerHeader = v.map(String)
  })
  const hasDevice = testerHeader.includes('Assigned device')
  check(
    data.audience === 'admin' ? hasDevice : !hasDevice,
    data.audience === 'admin'
      ? 'admin sees assigned device and browser'
      : 'customer does not see assigned device or browser',
  )

  // 5 · Nothing sensitive anywhere in the package.
  let leaked = ''
  for (const name of parts) {
    const text = await zip.file(name)!.async('string')
    for (const needle of [SECRET_EMAIL, SECRET_PHONE, 'secret-token', 'signed.example.invalid']) {
      if (text.includes(needle)) leaked = `${needle} in ${name}`
    }
  }
  check(
    leaked === '',
    leaked ? `LEAK: ${leaked}` : 'no email, phone or signed link anywhere in the file',
  )

  const colours = new Set<string>()
  for (const name of parts.filter((n) => /xl\/(styles|charts\/chart\d+)\.xml$/.test(n))) {
    for (const m of (await zip.file(name)!.async('string')).matchAll(
      /(?:rgb|val)="(?:FF)?([0-9A-F]{6})"/g,
    ))
      colours.add(m[1]!)
  }
  check(
    !colours.has('000000') && !colours.has('FFFFFF'),
    'no pure black or white in styles or charts',
  )
}

async function inspectEdges(): Promise<void> {
  console.log('\nEdge cases')
  const empty = fixture('customer', 0)
  empty.summary = null
  empty.features = null
  empty.testCases = [] as never
  empty.testers = []
  empty.materials = []
  empty.build = null
  const book = new ExcelJS.Workbook()
  await book.xlsx.load((await buildReportWorkbook(empty)) as never)
  const names = book.worksheets.map((s) => s.name)
  console.log(`        sheets: ${names.join(' | ')}`)
  check(
    names.includes('Detailed bug report') && names.includes('Executive summary'),
    'a build with no bugs, summary or build still produces a workbook',
  )
  check(
    !names.includes('Test results') &&
      !names.includes('Custom field answers') &&
      !names.includes('Bug history & comments'),
    'sheets with nothing to say are left out',
  )
  const detail = book.getWorksheet('Detailed bug report')!
  const cells: string[] = []
  detail.eachRow((row) => row.eachCell((c) => cells.push(show(c.value))))
  check(
    cells.some((c) => c.includes('No bugs have been reported')),
    'an empty bug list says so in words',
  )

  const unavailable = fixture('admin')
  unavailable.testCases = null
  unavailable.features = null
  const book2 = new ExcelJS.Workbook()
  await book2.xlsx.load((await buildReportWorkbook(unavailable)) as never)
  const tests = book2.getWorksheet('Test results')!
  const lines: string[] = []
  tests.eachRow((row) => row.eachCell((c) => lines.push(show(c.value))))
  check(
    lines.some((c) => c.includes('could not be loaded')),
    'unavailable test cases are reported as unavailable, not as none',
  )

  const large = fixture('admin', 3000)
  const started = Date.now()
  const file = await buildReportWorkbook(large)
  check(
    Date.now() - started < 20_000,
    `3,000 bugs build in ${((Date.now() - started) / 1000).toFixed(1)}s (${(file.length / 1_048_576).toFixed(1)} MB)`,
  )
}

async function main(): Promise<void> {
  await inspect('Admin report', fixture('admin'))
  await inspect('Customer report', fixture('customer'))
  await inspectEdges()

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

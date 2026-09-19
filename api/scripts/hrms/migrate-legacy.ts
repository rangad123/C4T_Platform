/**
 * Legacy HRMS (CodeIgniter/MySQL, `c4thrms`) → the Hr* models in this schema.
 *
 *   npx tsx scripts/hrms/migrate-legacy.ts --mode=dry-run
 *   npx tsx scripts/hrms/migrate-legacy.ts --mode=full
 *
 * ── Why this is not built on scripts/migration/
 *
 * That framework is proven but hardcoded to a different source and target: its
 * REGISTRY is a fixed array of the platform's 66 tables, ALL_LOADERS is six
 * hardcoded imports, legacyPool() is a module singleton, and run.ts calls
 * platform-specific fixups unconditionally. Its keyset/replay machinery exists
 * to survive 200k rows; this source is ~3,900 rows across 13 tables, which
 * fits in memory many times over — so the whole import runs in ONE transaction
 * and gives all-or-nothing semantics that per-batch commits gave up. Its
 * genuinely reusable parts (the value coercions, the reconciliation reporter,
 * the read-only connection settings) are imported directly below.
 *
 * Within that transaction, new rows are still written with createMany rather
 * than one statement each. A write per row is ~3,800 sequential round trips,
 * which failed three separate ways against a remote database — the transaction
 * timing out, then the server closing the connection underneath it. Reads that
 * decide insert-vs-update are likewise one query per table, not one per row.
 *
 * ── The rule this follows
 *
 * docs/MIGRATION.md records what the platform's own first run got wrong:
 * mappings written from the schema alone produced "plausible, well-formed,
 * wrong data, and a report that said everything was fine". Every mapping here
 * was derived from GROUP BY over the live database instead. Two traps that
 * caught: `holidaylist.year` is 0 on all 13 rows (derive from the date), and
 * `taxes.tax_month` contains "Semptember".
 *
 * Nothing is ever silently defaulted. A row either lands or is reported.
 */
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import {
  PrismaClient,
  HrRole,
  HrGender,
  HrEmployeeStatus,
  HrTaxRegime,
  HrLeaveRequestStatus,
  type Prisma,
} from '@prisma/client'
import { hashPassword } from '../../src/lib/password.js'
import { encryptHrFinancialDetails } from '../../src/lib/hrms/hr-encryption.js'
import { Reporter } from '../migration/report/reporter.js'
import { text, int } from '../migration/transform/values.js'

// ── Source connection ────────────────────────────────────────────────────────

/**
 * Every connection detail comes from the environment with no fallback: this
 * repository is public, and the old HR database's host and account are not
 * things to publish. See .env.example for the four keys.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required — see .env.example (LEGACY_HRMS_DB_*).`)
  return value
}

// dateStrings and bigNumberStrings are not preferences. Without the first, the
// driver reinterprets historical DATE/TIMESTAMP values through the running
// machine's timezone (+05:30 here) and silently moves them a day; without the
// second, int(100) ids round through a float. Both are documented causes of
// corruption in the platform's first migration run.
const LEGACY = {
  host: required('LEGACY_HRMS_DB_HOST'),
  port: Number(process.env.LEGACY_HRMS_DB_PORT ?? 3306),
  user: required('LEGACY_HRMS_DB_USER'),
  password: required('LEGACY_HRMS_DB_PASSWORD'),
  database: required('LEGACY_HRMS_DB_NAME'),
  dateStrings: true as const,
  supportBigNumbers: true as const,
  bigNumberStrings: true as const,
  connectTimeout: 20_000,
}

const SELECT_ONLY = /^\s*(select|show|describe|explain)\b/i

type LegacyRow = Record<string, unknown>

class LegacySource {
  constructor(private readonly conn: mysql.Connection) {}

  static async connect(): Promise<LegacySource> {
    return new LegacySource(await mysql.createConnection(LEGACY))
  }

  /** A seatbelt, not a security boundary — the real guarantee is the SELECT-only grant. */
  async query(sql: string): Promise<LegacyRow[]> {
    if (!SELECT_ONLY.test(sql)) {
      throw new Error(`Refusing to run a non-SELECT statement against the legacy database: ${sql}`)
    }
    const [rows] = await this.conn.query(sql)
    return rows as LegacyRow[]
  }

  async close(): Promise<void> {
    await this.conn.end()
  }
}

// ── Transforms, each derived from live values ────────────────────────────────

/** "2021-22" → "2021-2022". The target validator demands /^\d{4}-\d{4}$/. */
function financialYear(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const short = /^(\d{4})-(\d{2})$/.exec(raw)
  if (short) {
    const start = Number(short[1])
    const end = Number(`${short[1]!.slice(0, 2)}${short[2]}`)
    return end === start + 1 ? `${start}-${end}` : null
  }
  const long = /^(\d{4})-(\d{4})$/.exec(raw)
  if (long && Number(long[2]) === Number(long[1]) + 1) return raw
  return null
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  // Present in taxes.tax_month on 2 rows. Mapped explicitly rather than
  // fuzzy-matched, so a different typo fails loudly instead of guessing.
  semptember: 9,
  october: 10,
  november: 11,
  december: 12,
}

function monthNumber(value: unknown): number | null {
  const raw = text(value)
  if (!raw) return null
  return MONTHS[raw.trim().toLowerCase()] ?? null
}

/** @db.Date columns drift a day unless they are UTC midnight. */
function utcDate(value: unknown): Date | null {
  const raw = text(value)
  if (!raw) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!m) return null
  const [, y, mo, d] = m
  if (y === '0000') return null
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
}

function dateFromParts(month: unknown, year: unknown): Date | null {
  const m = int(month)
  const y = int(year)
  if (!m || !y || m < 1 || m > 12 || y < 1900) return null
  return new Date(Date.UTC(y, m - 1, 1))
}

function decimal(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const ROLES: Record<number, HrRole> = {
  1: HrRole.ADMIN,
  2: HrRole.ACCOUNT_MANAGER,
  3: HrRole.EMPLOYEE,
}

const GENDERS: Record<string, HrGender> = {
  male: HrGender.MALE,
  female: HrGender.FEMALE,
  others: HrGender.OTHER,
}

const STATUSES: Record<string, HrEmployeeStatus> = {
  joined: HrEmployeeStatus.ACTIVE,
  invited: HrEmployeeStatus.ACTIVE,
  resigned: HrEmployeeStatus.RESIGNED,
}

/** Legacy CL/PL/LOP → seeded leave type names. "Unpaid leave" is matched by
 *  string in hr-timesheet.service.ts, so the spelling is load-bearing. */
const LEAVE_TYPE_NAMES: Record<string, string> = {
  CL: 'Casual leave',
  PL: 'Earned leave',
  LOP: 'Unpaid leave',
}

const INCENTIVE_TYPE_NAMES: Record<string, string> = {
  'Performance Incentive': 'Performance incentive',
  'Project Incentive': 'Project incentive',
  'Extra Hours Incentive': 'Extra hours incentive',
}

/** Legacy wide investment columns → seeded HrInvestmentSection codes. */
const INVESTMENT_SECTIONS: { suffix: string; code: string }[] = [
  { suffix: '80c', code: '80C' },
  { suffix: '80ccd', code: '80CCD(1B)' },
  { suffix: '80d', code: '80D' },
  { suffix: '80ee', code: '80EE' },
  { suffix: '80eea', code: '80EEA' },
  { suffix: '80eeb', code: '80EEB' },
  { suffix: '80e', code: '80E' },
  { suffix: '24', code: '24' },
  { suffix: '13a', code: '10(13A)' },
]

const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function maskPanValue(pan: string | null): string | null {
  if (!pan || pan.length < 5) return null
  return `${pan.slice(0, 3)}***${pan.slice(-3)}`
}

function maskAccountValue(account: string | null): string | null {
  if (!account || account.length < 4) return null
  return `•••• ${account.slice(-4)}`
}

// ── Options ──────────────────────────────────────────────────────────────────

type Mode = 'dry-run' | 'full'

function parseMode(argv: string[]): Mode {
  const flag = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length) ?? 'dry-run'
  if (flag !== 'dry-run' && flag !== 'full') {
    throw new Error(`Unknown --mode=${flag}. Use dry-run or full.`)
  }
  return flag
}

/** Thrown to roll a dry run back. Never escapes runMigration. */
class DryRunRollback extends Error {}

// ── The migration ────────────────────────────────────────────────────────────

const prisma = new PrismaClient()

/**
 * Every legacy table, read in full before a single write happens.
 *
 * The whole source is ~3,900 rows, so holding it in memory costs nothing — and
 * it means the MySQL connection is open for seconds rather than for the length
 * of the import. Reading lazily inside the write transaction does not work:
 * hashing one Argon2 password per employee is deliberately slow, and the
 * legacy server closes an idle connection long before the transaction ends.
 */
type LegacyData = Record<
  | 'users'
  | 'accounts'
  | 'holidays'
  | 'salary'
  | 'activeSalary'
  | 'incentives'
  | 'taxes'
  | 'investments'
  | 'timesheet'
  | 'payslip',
  LegacyRow[]
>

async function loadLegacy(source: LegacySource): Promise<LegacyData> {
  const [
    users,
    accounts,
    holidays,
    salary,
    activeSalary,
    incentives,
    taxes,
    investments,
    timesheet,
    payslip,
  ] = await Promise.all([
    source.query('SELECT * FROM users ORDER BY user_id'),
    source.query('SELECT * FROM accounts ORDER BY account_id'),
    source.query('SELECT * FROM holidaylist ORDER BY date'),
    source.query('SELECT * FROM salary ORDER BY salary_id'),
    source.query('SELECT * FROM active_salary ORDER BY salary_id'),
    source.query('SELECT * FROM incentives ORDER BY incentive_id'),
    source.query('SELECT * FROM taxes ORDER BY tax_id'),
    source.query('SELECT * FROM investments ORDER BY investment_id'),
    source.query('SELECT * FROM timesheet ORDER BY timesheet_id'),
    source.query('SELECT * FROM payslip ORDER BY payslip_id'),
  ])
  return {
    users,
    accounts,
    holidays,
    salary,
    activeSalary,
    incentives,
    taxes,
    investments,
    timesheet,
    payslip,
  }
}

async function runMigration(): Promise<void> {
  const mode = parseMode(process.argv.slice(2))
  const reportDir = join(process.cwd(), 'migration-report-hrms')
  const reporter = new Reporter(reportDir)
  const startedAt = new Date()

  const source = await LegacySource.connect()
  let legacy: LegacyData
  try {
    legacy = await loadLegacy(source)
  } finally {
    await source.close()
  }
  const totalRead = Object.values(legacy).reduce((n, rows) => n + rows.length, 0)
  console.log(`read ${totalRead} legacy rows; source connection closed.`)

  // Plaintext temporary passwords, written once at the end. Never logged to
  // stdout and never stored in the database in any recoverable form.
  const tempPasswords: { employeeCode: string; email: string; password: string }[] = []

  try {
    await prisma.$transaction(
      async (tx) => {
        await importAll(tx, legacy, reporter, tempPasswords)
        if (mode === 'dry-run') throw new DryRunRollback()
      },
      // Deliberately generous. Against the production database this whole
      // import is a few seconds — it runs on the same box, ~1ms per round
      // trip. The ceiling exists for running it from a laptop against a
      // remote database, where ~3,800 sequential writes at WAN latency take
      // far longer than any default allows.
      { timeout: 2_700_000, maxWait: 30_000 },
    )
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error
  }

  const reportPath = reporter.write({
    mode,
    runId: null,
    source: `${LEGACY.host}:${LEGACY.port}/${LEGACY.database}`,
    startedAt,
    finishedAt: new Date(),
    notMigrated: [
      {
        legacyTable: 'leaves',
        disposition: 'DEPRECATED',
        notes:
          'Abandoned in the old app — all 22 rows are April 2021-22, superseded by timesheet leave rows through 2024.',
      },
      {
        legacyTable: 'templates',
        disposition: 'NO_EQUIVALENT',
        notes:
          'HrTemplate.fileId is required and the document bytes live on the legacy filesystem, unreachable over MySQL. Re-upload the 9 files through the admin UI.',
      },
      {
        legacyTable: 'payslip_status',
        disposition: 'NO_EQUIVALENT',
        notes: 'Per-month generation flag with no counterpart; every row is "Generated".',
      },
    ],
  })

  if (mode === 'full' && tempPasswords.length > 0) {
    mkdirSync(reportDir, { recursive: true })
    const file = join(reportDir, 'temporary-passwords.csv')
    writeFileSync(
      file,
      ['employee_code,email,temporary_password']
        .concat(tempPasswords.map((p) => `${p.employeeCode},${p.email},${p.password}`))
        .join('\n'),
      'utf8',
    )
    console.log(`\nTemporary passwords written to ${file} — distribute, then DELETE this file.`)
  }

  console.log(`\nmode=${mode}. Report written to ${reportPath}`)
  for (const c of reporter.allCounters()) {
    const balanced = c.inserted + c.updated + c.skipped + c.failed === c.read
    console.log(
      `  ${c.legacyTable} → ${c.targetModel}: read ${c.read}, inserted ${c.inserted}, ` +
        `updated ${c.updated}, skipped ${c.skipped}, failed ${c.failed}${balanced ? '' : '  ← DOES NOT BALANCE'}`,
    )
  }
  if (mode === 'dry-run') console.log('\nNothing was written — this was a dry run.')
}

async function importAll(
  tx: Prisma.TransactionClient,
  legacy: LegacyData,
  reporter: Reporter,
  tempPasswords: { employeeCode: string; email: string; password: string }[],
): Promise<void> {
  // Catalogs must already be seeded — seed-catalog.ts owns them.
  const [designations, leaveTypes, incentiveTypes, sections] = await Promise.all([
    tx.hrDesignation.findMany({ select: { id: true, name: true } }),
    tx.hrLeaveType.findMany({ select: { id: true, name: true } }),
    tx.hrIncentiveType.findMany({ select: { id: true, name: true } }),
    tx.hrInvestmentSection.findMany({ select: { id: true, code: true } }),
  ])
  const designationByName = new Map(designations.map((d) => [d.name, d.id]))
  const leaveTypeByName = new Map(leaveTypes.map((l) => [l.name, l.id]))
  const incentiveTypeByName = new Map(incentiveTypes.map((i) => [i.name, i.id]))
  const sectionByCode = new Map(sections.map((s) => [s.code, s.id]))

  const missingSections = INVESTMENT_SECTIONS.filter((s) => !sectionByCode.has(s.code))
  if (missingSections.length > 0) {
    throw new Error(
      `Investment sections not seeded: ${missingSections.map((s) => s.code).join(', ')} — run seed-catalog.ts first.`,
    )
  }

  const employeeIdByLegacy = await importEmployees(
    tx,
    legacy.users,
    reporter,
    designationByName,
    tempPasswords,
  )
  await linkManagers(tx, legacy.users, reporter, employeeIdByLegacy)
  await importFinancialDetails(tx, legacy.accounts, reporter, employeeIdByLegacy)
  await importHolidays(tx, legacy.holidays, reporter)
  await importOldSalaries(tx, legacy.salary, reporter, employeeIdByLegacy)
  await importSalaryStructures(tx, legacy, reporter, employeeIdByLegacy)
  await importIncentives(tx, legacy.incentives, reporter, employeeIdByLegacy, incentiveTypeByName)
  await importTaxDeductions(tx, legacy.taxes, reporter, employeeIdByLegacy)
  await importInvestments(tx, legacy.investments, reporter, employeeIdByLegacy, sectionByCode)
  await importTimesheet(tx, legacy.timesheet, reporter, employeeIdByLegacy, leaveTypeByName)
  await importPayslips(tx, legacy.payslip, reporter, employeeIdByLegacy)
}

// ── users → HrEmployee ───────────────────────────────────────────────────────

async function importEmployees(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  designationByName: Map<string, string>,
  tempPasswords: { employeeCode: string; email: string; password: string }[],
): Promise<Map<string, string>> {
  const counter = reporter.counter('users', 'HrEmployee')
  const byLegacy = new Map<string, string>()

  // One read for the whole table instead of one per row. A read-per-row turns
  // this import into ~7,600 sequential round trips, which is what expired the
  // transaction (P2028) the first time this was run against a remote database.
  const existingRows = await tx.hrEmployee.findMany({
    select: { id: true, email: true, legacyId: true },
  })
  const existingByEmail = new Map(existingRows.map((e) => [e.email, e]))
  const existingByLegacyId = new Map(
    existingRows.filter((e) => e.legacyId).map((e) => [e.legacyId!, e]),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.user_id)
    const email = text(row.user_email)?.toLowerCase()
    const employeeCode = text(row.employee_id)

    if (!email) {
      reporter.skip('users', legacyId, 'HrEmployee', 'NO_EMAIL', 'Row has no email address.')
      counter.skipped += 1
      continue
    }
    if (!employeeCode) {
      reporter.skip('users', legacyId, 'HrEmployee', 'NO_EMPLOYEE_CODE', 'Row has no employee id.')
      counter.skipped += 1
      continue
    }

    // joiningDate is NOT NULL. One resigned employee (user 49) has none.
    let joiningDate = utcDate(row.user_joining_date)
    if (!joiningDate) {
      joiningDate = utcDate(row.user_added_date)
      reporter.problem({
        legacyTable: 'users',
        legacyId,
        targetModel: 'HrEmployee',
        code: 'JOINING_DATE_DEFAULTED',
        field: 'user_joining_date',
        value: null,
        message: 'No joining date; fell back to user_added_date.',
        action: 'DEFAULTED',
      })
    }
    if (!joiningDate) {
      reporter.skip(
        'users',
        legacyId,
        'HrEmployee',
        'NO_JOINING_DATE',
        'No joining date and no added date to fall back to.',
      )
      counter.skipped += 1
      continue
    }

    const roleId = int(row.user_role_id)
    const role = roleId !== null ? ROLES[roleId] : undefined
    if (!role) {
      reporter.skip(
        'users',
        legacyId,
        'HrEmployee',
        'UNKNOWN_ROLE',
        `user_role_id ${String(row.user_role_id)} has no mapping.`,
        { field: 'user_role_id', value: String(row.user_role_id) },
      )
      counter.skipped += 1
      continue
    }

    const statusRaw = text(row.joining_status)?.toLowerCase() ?? ''
    const status = STATUSES[statusRaw]
    if (!status) {
      reporter.skip(
        'users',
        legacyId,
        'HrEmployee',
        'UNKNOWN_STATUS',
        `joining_status "${statusRaw}" has no mapping.`,
        { field: 'joining_status', value: statusRaw },
      )
      counter.skipped += 1
      continue
    }

    const designationName = text(row.user_designation)
    const designationId = designationName ? designationByName.get(designationName) : undefined
    if (designationName && !designationId) {
      reporter.problem({
        legacyTable: 'users',
        legacyId,
        targetModel: 'HrEmployee',
        code: 'DESIGNATION_NOT_IN_CATALOG',
        field: 'user_designation',
        value: designationName,
        message: 'Designation is not a seeded catalog entry; left unset.',
        action: 'REVIEW_REQUIRED',
      })
    }

    const genderRaw = text(row.user_gender)?.toLowerCase()
    const gender = genderRaw ? (GENDERS[genderRaw] ?? null) : null

    const common = {
      employeeCode,
      firstName: text(row.user_firstname) ?? employeeCode,
      lastName: text(row.user_lastname) ?? '',
      dateOfBirth: utcDate(row.user_dob),
      gender,
      phone: text(row.user_phone),
      address: text(row.user_address),
      designationId: designationId ?? null,
      role,
      joiningDate,
      relievingDate: utcDate(row.user_relieving_date),
      timesheetRequired: text(row.timesheet_required)?.toLowerCase() !== 'no',
      status,
      taxRegime: text(row.tax_regime)?.toLowerCase() === 'old' ? HrTaxRegime.OLD : HrTaxRegime.NEW,
      legacyId,
    }

    // The seeded production admin already owns admin@crowd4test.com and is the
    // same person as legacy user 1. Update that row rather than colliding with
    // it, and never touch its passwordHash — it is a working login.
    const existing = existingByLegacyId.get(legacyId) ?? existingByEmail.get(email)

    if (existing) {
      await tx.hrEmployee.update({ where: { id: existing.id }, data: common })
      byLegacy.set(legacyId, existing.id)
      counter.updated += 1
      reporter.mapping({
        legacyTable: 'users',
        legacyId,
        targetModel: 'HrEmployee',
        targetId: existing.id,
      })
      continue
    }

    // Legacy passwords are unsalted MD5 and are deliberately not carried over.
    const password = randomBytes(12).toString('base64url')
    const created = await tx.hrEmployee.create({
      data: { ...common, email, passwordHash: await hashPassword(password) },
      select: { id: true },
    })
    tempPasswords.push({ employeeCode, email, password })
    byLegacy.set(legacyId, created.id)
    counter.inserted += 1
    reporter.mapping({
      legacyTable: 'users',
      legacyId,
      targetModel: 'HrEmployee',
      targetId: created.id,
    })
  }

  return byLegacy
}

/** Second pass — reportsToId is a self-relation, so every row must exist first. */
async function linkManagers(
  tx: Prisma.TransactionClient,
  users: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
): Promise<void> {
  const rows = users.filter((u) => {
    const manager = int(u.user_account_manager)
    return manager !== null && manager !== 0
  })
  for (const row of rows) {
    const legacyId = String(row.user_id)
    const managerLegacyId = String(row.user_account_manager)
    const employeeId = byLegacy.get(legacyId)
    const managerId = byLegacy.get(managerLegacyId)
    if (!employeeId) continue
    if (!managerId) {
      reporter.orphan({
        legacyTable: 'users',
        legacyId,
        field: 'user_account_manager',
        referencedTable: 'users',
        referencedId: managerLegacyId,
      })
      continue
    }
    await tx.hrEmployee.update({ where: { id: employeeId }, data: { reportsToId: managerId } })
  }
}

// ── accounts → encrypted financial details ───────────────────────────────────

async function importFinancialDetails(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('accounts', 'HrEmployee.secureFinancialDetails')

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.account_id)
    const employeeId = byLegacy.get(String(row.user_id))
    if (!employeeId) {
      reporter.orphan({
        legacyTable: 'accounts',
        legacyId,
        field: 'user_id',
        referencedTable: 'users',
        referencedId: String(row.user_id),
      })
      reporter.skip(
        'accounts',
        legacyId,
        'HrEmployee',
        'ORPHAN',
        'No migrated employee for this user_id.',
      )
      counter.skipped += 1
      continue
    }

    // The migration writes past the Zod layer that normally trims/uppercases.
    const panNumber = text(row.pan_number)?.trim().toUpperCase()
    const ifscCode = text(row.ifsc_code)?.trim().toUpperCase()
    const accountNumber = text(row.account_number)?.trim()
    const accountName = text(row.account_name)?.trim()

    if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) {
      reporter.problem({
        legacyTable: 'accounts',
        legacyId,
        targetModel: 'HrEmployee',
        code: 'PAN_FORMAT',
        field: 'pan_number',
        value: null, // never write a real PAN to a report file
        message: 'PAN does not match the expected format; imported as-is.',
        action: 'REVIEW_REQUIRED',
      })
    }
    if (ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
      reporter.problem({
        legacyTable: 'accounts',
        legacyId,
        targetModel: 'HrEmployee',
        code: 'IFSC_FORMAT',
        field: 'ifsc_code',
        value: ifscCode,
        message: 'IFSC does not match the expected format; imported as-is.',
        action: 'REVIEW_REQUIRED',
      })
    }

    const hasAny = [panNumber, accountNumber, accountName, ifscCode].some((v) => Boolean(v))
    // AAD is the employee's own cuid — the envelope cannot be built before the
    // row exists, and a wrong AAD fails tag verification on every later read.
    const envelope = hasAny
      ? encryptHrFinancialDetails({ panNumber, accountNumber, accountName, ifscCode }, employeeId)
      : null

    await tx.hrEmployee.update({
      where: { id: employeeId },
      data: {
        secureFinancialDetails: envelope ? new Uint8Array(envelope) : null,
        bankName: text(row.bank_name),
        branchName: text(row.branch_name),
      },
    })
    counter.updated += 1
  }
}

// ── holidaylist → HrHoliday ──────────────────────────────────────────────────

async function importHolidays(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
): Promise<void> {
  const counter = reporter.counter('holidaylist', 'HrHoliday')
  const toCreate: Prisma.HrHolidayCreateManyInput[] = []
  const existing = new Map(
    (await tx.hrHoliday.findMany({ select: { id: true, year: true, date: true } })).map((h) => [
      `${h.year}:${h.date.toISOString().slice(0, 10)}`,
      h.id,
    ]),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.s_no)
    const date = utcDate(row.date)
    const name = text(row.name)
    if (!date || !name) {
      reporter.skip('holidaylist', legacyId, 'HrHoliday', 'INCOMPLETE', 'Missing date or name.')
      counter.skipped += 1
      continue
    }
    // `year` is 0 on every legacy row — derive it, never read it.
    const year = date.getUTCFullYear()
    const key = `${year}:${date.toISOString().slice(0, 10)}`
    const existingId = existing.get(key)
    if (existingId) {
      await tx.hrHoliday.update({ where: { id: existingId }, data: { name } })
      counter.updated += 1
    } else {
      toCreate.push({ year, date, name })
      counter.inserted += 1
    }
  }

  if (toCreate.length > 0) await tx.hrHoliday.createMany({ data: toCreate })
}

// ── salary → HrOldSalary ─────────────────────────────────────────────────────

async function importOldSalaries(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('salary', 'HrOldSalary')
  const toCreate: Prisma.HrOldSalaryCreateManyInput[] = []
  const existing = new Map(
    (
      await tx.hrOldSalary.findMany({
        where: { legacyId: { not: null } },
        select: { id: true, legacyId: true },
      })
    ).map((r) => [r.legacyId!, r.id]),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.salary_id)
    const employeeId = byLegacy.get(String(row.user_id))
    if (!employeeId) {
      reporter.skip('salary', legacyId, 'HrOldSalary', 'ORPHAN', 'No migrated employee.')
      counter.skipped += 1
      continue
    }
    // Prefer the month/year parts, which are exact. They are 0 on 42 of 71
    // rows — the older entries, where the old app recorded only the financial
    // year — so fall back to that year's April→March span rather than dropping
    // more than half the CTC history.
    let fromDate = dateFromParts(row.salary_start_month, row.salary_start_year)
    let toDate = dateFromParts(row.salary_end_month, row.salary_end_year)

    if (!fromDate || !toDate) {
      const fy = financialYear(row.salary_fy)
      if (fy) {
        const startYear = Number(fy.slice(0, 4))
        fromDate = new Date(Date.UTC(startYear, 3, 1)) // 1 April
        toDate = new Date(Date.UTC(startYear + 1, 2, 31)) // 31 March
        reporter.problem({
          legacyTable: 'salary',
          legacyId,
          targetModel: 'HrOldSalary',
          code: 'DATE_RANGE_FROM_FINANCIAL_YEAR',
          field: null,
          value: fy,
          message:
            'Start/end month and year were both 0; the range is the financial year, 1 April to 31 March.',
          action: 'DEFAULTED',
        })
      }
    }

    if (!fromDate || !toDate) {
      reporter.skip(
        'salary',
        legacyId,
        'HrOldSalary',
        'NO_DATE_RANGE',
        'No usable month/year parts and no financial year to fall back to.',
      )
      counter.skipped += 1
      continue
    }

    const data = { employeeId, ctc: decimal(row.ctc), fromDate, toDate, legacyId }
    const existingId = existing.get(legacyId)
    if (existingId) {
      await tx.hrOldSalary.update({ where: { id: existingId }, data })
      counter.updated += 1
    } else {
      toCreate.push(data)
      counter.inserted += 1
    }
  }

  if (toCreate.length > 0) await tx.hrOldSalary.createMany({ data: toCreate })
}

// ── active_salary + payslip components → HrSalaryStructure ───────────────────

async function importSalaryStructures(
  tx: Prisma.TransactionClient,
  legacy: LegacyData,
  reporter: Reporter,
  byLegacy: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('active_salary', 'HrSalaryStructure')
  const toCreate = new Map<string, Prisma.HrSalaryStructureCreateManyInput>()
  const rows = legacy.activeSalary
  const existing = new Map(
    (
      await tx.hrSalaryStructure.findMany({
        select: { id: true, employeeId: true, financialYear: true },
      })
    ).map((s) => [`${s.employeeId}:${s.financialYear}`, s.id]),
  )

  // The legacy CTC is a single number; the new model wants a component
  // breakdown. The most recent payslip is the only place that breakdown exists,
  // so annualise it (monthly × 12) rather than inventing a split.
  const componentsByUser = new Map<string, LegacyRow>()
  for (const p of legacy.payslip) {
    const userId = String(p.user_id)
    const seen = componentsByUser.get(userId)
    if (!seen || Number(p.payslip_id) > Number(seen.payslip_id)) componentsByUser.set(userId, p)
  }

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.salary_id)
    const employeeId = byLegacy.get(String(row.user_id))
    if (!employeeId) {
      reporter.skip(
        'active_salary',
        legacyId,
        'HrSalaryStructure',
        'ORPHAN',
        'No migrated employee.',
      )
      counter.skipped += 1
      continue
    }

    const startMonth = int(row.salary_start_month)
    const startYear = int(row.salary_start_year)
    if (!startMonth || !startYear) {
      reporter.skip(
        'active_salary',
        legacyId,
        'HrSalaryStructure',
        'NO_START',
        'Missing start month/year, so the financial year cannot be derived.',
      )
      counter.skipped += 1
      continue
    }
    // Indian FY runs April–March: Jan–Mar belong to the previous FY's label.
    const fyStart = startMonth >= 4 ? startYear : startYear - 1
    const fy = `${fyStart}-${fyStart + 1}`

    const components = componentsByUser.get(String(row.user_id))
    const basic = decimal(components?.sal_basic) * 12
    const hra = decimal(components?.sal_hra) * 12
    const special = decimal(components?.sal_special_allowance) * 12
    if (!components) {
      reporter.problem({
        legacyTable: 'active_salary',
        legacyId,
        targetModel: 'HrSalaryStructure',
        code: 'NO_COMPONENT_BREAKDOWN',
        field: null,
        value: null,
        message:
          'No payslip to derive basic/HRA/allowance from; only the annual CTC total was imported.',
        action: 'REVIEW_REQUIRED',
      })
    }

    const data = {
      basic,
      hra,
      specialAllowance: special,
      totalFixedAnnual: decimal(row.ctc),
    }
    // The key map is also written back to, not just read: two legacy rows can
    // resolve to the same (employee, financial year) — 45 active_salary rows
    // cover 44 employees — and the later one must update the row the earlier
    // one just created rather than collide with it.
    const key = `${employeeId}:${fy}`
    const existingId = existing.get(key)
    if (existingId) {
      await tx.hrSalaryStructure.update({ where: { id: existingId }, data })
      counter.updated += 1
      reporter.problem({
        legacyTable: 'active_salary',
        legacyId,
        targetModel: 'HrSalaryStructure',
        code: 'DUPLICATE_FOR_FINANCIAL_YEAR',
        field: null,
        value: fy,
        message: `Another active_salary row already covers ${fy} for this employee; the later row wins.`,
        action: 'REVIEW_REQUIRED',
      })
    } else if (toCreate.has(key)) {
      // A second legacy row for the same year, not yet written. Replace the
      // pending record rather than colliding on the unique constraint, and
      // count it the same way the already-in-database case above does.
      toCreate.set(key, { ...data, employeeId, financialYear: fy })
      counter.updated += 1
      reporter.problem({
        legacyTable: 'active_salary',
        legacyId,
        targetModel: 'HrSalaryStructure',
        code: 'DUPLICATE_FOR_FINANCIAL_YEAR',
        field: null,
        value: fy,
        message: `Another active_salary row already covers ${fy} for this employee; the later row wins.`,
        action: 'REVIEW_REQUIRED',
      })
    } else {
      toCreate.set(key, { ...data, employeeId, financialYear: fy })
      counter.inserted += 1
    }
  }

  if (toCreate.size > 0) {
    await tx.hrSalaryStructure.createMany({ data: [...toCreate.values()] })
  }
}

// ── incentives → HrMonthlyIncentive ──────────────────────────────────────────

async function importIncentives(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
  incentiveTypeByName: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('incentives', 'HrMonthlyIncentive')
  const toCreate: Prisma.HrMonthlyIncentiveCreateManyInput[] = []
  const existing = new Map(
    (
      await tx.hrMonthlyIncentive.findMany({
        where: { legacyId: { not: null } },
        select: { id: true, legacyId: true },
      })
    ).map((r) => [r.legacyId!, r.id]),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.incentive_id)
    const employeeId = byLegacy.get(String(row.user_id))
    const fy = financialYear(row.incentive_fy)
    const month = monthNumber(row.incentive_month)
    const legacyType = text(row.incentive_type)
    const typeName = legacyType ? INCENTIVE_TYPE_NAMES[legacyType] : undefined
    const incentiveTypeId = typeName ? incentiveTypeByName.get(typeName) : undefined

    if (!employeeId || !fy || !month || !incentiveTypeId) {
      reporter.skip(
        'incentives',
        legacyId,
        'HrMonthlyIncentive',
        'UNRESOLVED',
        `Could not resolve ${[
          !employeeId && 'employee',
          !fy && 'financial year',
          !month && 'month',
          !incentiveTypeId && `incentive type "${legacyType ?? ''}"`,
        ]
          .filter(Boolean)
          .join(', ')}.`,
      )
      counter.skipped += 1
      continue
    }

    const data = {
      employeeId,
      financialYear: fy,
      month,
      incentiveTypeId,
      amount: decimal(row.incentive),
      legacyId,
    }
    const existingId = existing.get(legacyId)
    if (existingId) {
      await tx.hrMonthlyIncentive.update({ where: { id: existingId }, data })
      counter.updated += 1
    } else {
      toCreate.push(data)
      counter.inserted += 1
    }
  }

  if (toCreate.length > 0) await tx.hrMonthlyIncentive.createMany({ data: toCreate })
}

// ── taxes → HrMonthlyTaxDeduction ────────────────────────────────────────────

async function importTaxDeductions(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('taxes', 'HrMonthlyTaxDeduction')
  const toCreate: Prisma.HrMonthlyTaxDeductionCreateManyInput[] = []
  const existing = new Map(
    (
      await tx.hrMonthlyTaxDeduction.findMany({
        select: { id: true, employeeId: true, financialYear: true, month: true },
      })
    ).map((r) => [`${r.employeeId}:${r.financialYear}:${r.month}`, r.id]),
  )

  /**
   * The old app allowed several TDS entries in one month — one employee has
   * three for a single month — but the target holds ONE row per employee per
   * month, because `amount` means that month's total deduction. So the legacy
   * rows are summed per month first. Writing them one at a time would make the
   * last row silently overwrite the others and understate the year's tax.
   *
   * Pre-aggregating also keeps the import idempotent: a re-run writes the same
   * total rather than adding to what is already there.
   */
  const totals = new Map<string, number>()
  for (const row of rows) {
    const employeeId = byLegacy.get(String(row.user_id))
    const fy = financialYear(row.tax_fy)
    const month = monthNumber(row.tax_month)
    if (!employeeId || !fy || !month) continue
    const key = `${employeeId}:${fy}:${month}`
    totals.set(key, (totals.get(key) ?? 0) + decimal(row.tax))
  }
  const written = new Set<string>()

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.tax_id)
    const employeeId = byLegacy.get(String(row.user_id))
    const fy = financialYear(row.tax_fy)
    const month = monthNumber(row.tax_month)

    if (!employeeId || !fy || !month) {
      reporter.skip(
        'taxes',
        legacyId,
        'HrMonthlyTaxDeduction',
        'UNRESOLVED',
        `Could not resolve ${[
          !employeeId && 'employee',
          !fy && 'financial year',
          !month && `month "${text(row.tax_month) ?? ''}"`,
        ]
          .filter(Boolean)
          .join(', ')}.`,
        { field: 'tax_month', value: text(row.tax_month) ?? '' },
      )
      counter.skipped += 1
      continue
    }

    const key = `${employeeId}:${fy}:${month}`
    const amount = totals.get(key) ?? decimal(row.tax)

    // Only the first legacy row for a month writes; the rest are already
    // included in that month's total and are recorded as merged, not dropped.
    if (written.has(key)) {
      counter.updated += 1
      reporter.problem({
        legacyTable: 'taxes',
        legacyId,
        targetModel: 'HrMonthlyTaxDeduction',
        code: 'MERGED_INTO_MONTH_TOTAL',
        field: null,
        value: String(decimal(row.tax)),
        message: `Another deduction already covers ${fy} month ${month}; this amount is summed into that month's total.`,
        action: 'REVIEW_REQUIRED',
      })
      continue
    }
    written.add(key)

    const existingId = existing.get(key)
    if (existingId) {
      await tx.hrMonthlyTaxDeduction.update({ where: { id: existingId }, data: { amount } })
      counter.updated += 1
    } else {
      toCreate.push({ employeeId, financialYear: fy, month, amount })
      counter.inserted += 1
    }
  }

  if (toCreate.length > 0) await tx.hrMonthlyTaxDeduction.createMany({ data: toCreate })
}

// ── investments (wide) → HrInvestmentDeclaration (tall) ──────────────────────

async function importInvestments(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
  sectionByCode: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('investments', 'HrInvestmentDeclaration')
  const toCreate: Prisma.HrInvestmentDeclarationCreateManyInput[] = []
  const existing = new Map(
    (
      await tx.hrInvestmentDeclaration.findMany({
        where: { legacyId: { not: null } },
        select: { id: true, legacyId: true },
      })
    ).map((r) => [r.legacyId!, r.id]),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyRowId = String(row.investment_id)
    const employeeId = byLegacy.get(String(row.user_id))
    const fy = financialYear(row.investment_fy)
    if (!employeeId || !fy) {
      reporter.skip(
        'investments',
        legacyRowId,
        'HrInvestmentDeclaration',
        'UNRESOLVED',
        `Could not resolve ${[!employeeId && 'employee', !fy && 'financial year'].filter(Boolean).join(', ')}.`,
      )
      counter.skipped += 1
      continue
    }

    let wrote = 0
    for (const { suffix, code } of INVESTMENT_SECTIONS) {
      const declared = decimal(row[`declaration_${suffix}`])
      const actual = decimal(row[`actual_${suffix}`])
      if (declared === 0 && actual === 0) continue

      const sectionId = sectionByCode.get(code)!
      const legacyId = `${legacyRowId}:${code}`
      const data = {
        employeeId,
        financialYear: fy,
        sectionId,
        declaredAmount: declared,
        verifiedAmount: actual === 0 ? null : actual,
        legacyId,
      }
      const existingId = existing.get(legacyId)
      if (existingId) {
        await tx.hrInvestmentDeclaration.update({ where: { id: existingId }, data })
      } else {
        toCreate.push(data)
      }
      wrote += 1
    }

    if (wrote === 0) {
      reporter.skip(
        'investments',
        legacyRowId,
        'HrInvestmentDeclaration',
        'ALL_ZERO',
        'Every section on this row is zero; nothing to declare.',
      )
      counter.skipped += 1
    } else {
      counter.inserted += 1
    }
  }

  if (toCreate.length > 0) await tx.hrInvestmentDeclaration.createMany({ data: toCreate })
}

// ── timesheet → HrTimesheetEntry + HrLeaveRequest ────────────────────────────

async function importTimesheet(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
  leaveTypeByName: Map<string, string>,
): Promise<void> {
  const entryCounter = reporter.counter('timesheet', 'HrTimesheetEntry')
  const leaveCounter = reporter.counter('timesheet', 'HrLeaveRequest')
  /**
   * New rows are collected and inserted with createMany at the end instead of
   * one at a time. This is the largest table by far, and a write per row meant
   * ~2,800 sequential round trips inside the transaction — which is what made
   * the import fail three different ways against a remote database (the
   * transaction timing out, then the server closing the connection). Batched,
   * it is a couple of statements.
   */
  const newEntries = new Map<string, Prisma.HrTimesheetEntryCreateManyInput>()
  const newLeave = new Map<string, Prisma.HrLeaveRequestCreateManyInput>()
  const existingEntries = new Map(
    (
      await tx.hrTimesheetEntry.findMany({ select: { id: true, employeeId: true, date: true } })
    ).map((e) => [`${e.employeeId}:${e.date.toISOString().slice(0, 10)}`, e.id]),
  )
  const existingLeave = new Map(
    (
      await tx.hrLeaveRequest.findMany({
        where: { legacyId: { not: null } },
        select: { id: true, legacyId: true },
      })
    ).map((r) => [r.legacyId!, r.id]),
  )

  for (const row of rows) {
    const legacyId = String(row.timesheet_id)
    const type = text(row.type) ?? ''
    const employeeId = byLegacy.get(String(row.user_id))
    const date = utcDate(row.date)
    const fy = financialYear(row.timesheet_fy)

    // Holidays are global in HrHoliday and derived, never per-employee rows.
    if (type === 'Holiday') continue

    const counter = type === 'Leave' ? leaveCounter : entryCounter
    counter.read += 1

    if (!employeeId || !date || !fy) {
      reporter.skip(
        'timesheet',
        legacyId,
        type === 'Leave' ? 'HrLeaveRequest' : 'HrTimesheetEntry',
        'UNRESOLVED',
        `Could not resolve ${[!employeeId && 'employee', !date && 'date', !fy && 'financial year'].filter(Boolean).join(', ')}.`,
      )
      counter.skipped += 1
      continue
    }

    if (type === 'Leave') {
      const code = text(row.leave_type)
      const typeName = code ? LEAVE_TYPE_NAMES[code] : undefined
      const leaveTypeId = typeName ? leaveTypeByName.get(typeName) : undefined
      if (!leaveTypeId) {
        reporter.skip(
          'timesheet',
          legacyId,
          'HrLeaveRequest',
          'NO_LEAVE_TYPE',
          `Leave row has no usable leave_type (got "${code ?? 'null'}").`,
          { field: 'leave_type', value: code ?? '' },
        )
        counter.skipped += 1
        continue
      }
      // Legacy recorded leave one day at a time, so each row is a single-day
      // request. Already taken, hence APPROVED.
      const leaveLegacyId = `ts:${legacyId}`
      const data = {
        employeeId,
        leaveTypeId,
        startDate: date,
        endDate: date,
        days: 1,
        reason: text(row.description),
        status: HrLeaveRequestStatus.APPROVED,
        legacyId: leaveLegacyId,
      }
      const existingLeaveId = existingLeave.get(leaveLegacyId)
      if (existingLeaveId) {
        await tx.hrLeaveRequest.update({ where: { id: existingLeaveId }, data })
        counter.updated += 1
      } else {
        newLeave.set(leaveLegacyId, data)
        counter.inserted += 1
      }
      continue
    }

    // `time` is MINUTES in the legacy app (120–1005), not hours.
    const minutes = int(row.time) ?? 0
    const totalHours = minutes / 60
    const hours = Math.min(totalHours, 8)
    const extraHours = Math.max(0, totalHours - 8)
    const month = date.getUTCMonth() + 1

    const data = {
      financialYear: fy,
      month,
      description: text(row.description),
      hours: Number(hours.toFixed(2)),
      extraHours: Number(extraHours.toFixed(2)),
    }
    const entryKey = `${employeeId}:${date.toISOString().slice(0, 10)}`
    const existingEntryId = existingEntries.get(entryKey)
    if (existingEntryId) {
      await tx.hrTimesheetEntry.update({ where: { id: existingEntryId }, data })
      counter.updated += 1
    } else {
      // Keyed rather than pushed, so a second legacy row for the same day
      // replaces the first instead of breaking the unique constraint — the
      // same "later row wins" rule the per-row path used. The source has no
      // such duplicates today; this keeps the counts balancing if it grows any.
      if (newEntries.has(entryKey)) counter.updated += 1
      else counter.inserted += 1
      newEntries.set(entryKey, { ...data, employeeId, date })
    }
  }

  if (newEntries.size > 0) {
    await tx.hrTimesheetEntry.createMany({ data: [...newEntries.values()] })
  }
  if (newLeave.size > 0) {
    await tx.hrLeaveRequest.createMany({ data: [...newLeave.values()] })
  }
}

// ── payslip → HrPayslip ──────────────────────────────────────────────────────

async function importPayslips(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  byLegacy: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('payslip', 'HrPayslip')
  const toCreate = new Map<string, Prisma.HrPayslipCreateManyInput>()
  const existing = new Map(
    (
      await tx.hrPayslip.findMany({
        select: { id: true, employeeId: true, financialYear: true, month: true },
      })
    ).map((p) => [`${p.employeeId}:${p.financialYear}:${p.month}`, p.id]),
  )

  const employees = await tx.hrEmployee.findMany({
    where: { id: { in: [...byLegacy.values()] } },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      email: true,
      designation: { select: { name: true } },
    },
  })
  const employeeById = new Map(employees.map((e) => [e.id, e]))

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.payslip_id)
    const employeeId = byLegacy.get(String(row.user_id))
    const fy = financialYear(row.finance_year)
    const month = monthNumber(row.month)
    const generatedById = byLegacy.get(String(row.saved_by))

    if (!employeeId || !fy || !month) {
      reporter.skip(
        'payslip',
        legacyId,
        'HrPayslip',
        'UNRESOLVED',
        `Could not resolve ${[!employeeId && 'employee', !fy && 'financial year', !month && 'month'].filter(Boolean).join(', ')}.`,
      )
      counter.skipped += 1
      continue
    }

    const employee = employeeById.get(employeeId)!
    const basic = decimal(row.sal_basic)
    const hra = decimal(row.sal_hra)
    const special = decimal(row.sal_special_allowance)
    const incentives = decimal(row.sal_incentives)
    const professionalTax = decimal(row.tax_professional_tax)
    const incomeTax = decimal(row.tax_income_tax)
    const gross = basic + hra + special + incentives
    const totalDeductions = professionalTax + incomeTax

    // Matches PayslipSnapshot in hr-payslip-template.ts. Professional tax has
    // no field of its own there, so it is carried as its own deduction line
    // rather than being folded away and lost.
    const snapshot = {
      employee: {
        employeeCode: employee.employeeCode,
        firstName: employee.firstName,
        lastName: employee.lastName,
        designation: employee.designation?.name ?? null,
        email: employee.email,
        panMasked: maskPanValue(text(row.pan_no)),
        bankName: text(row.bank_name),
        accountNumberMasked: maskAccountValue(text(row.account_no)),
      },
      financialYear: fy,
      month,
      monthLabel: MONTH_LABELS[month - 1]!,
      earnings: {
        basicMonthly: basic,
        hraMonthly: hra,
        specialAllowanceMonthly: special,
        incentives: incentives > 0 ? [{ label: 'Incentives', amount: incentives }] : [],
        grossMonthly: gross,
      },
      deductions: {
        tdsMonthly: incomeTax,
        professionalTaxMonthly: professionalTax,
        totalDeductions,
      },
      netPay: gross - totalDeductions,
      generatedAt: (text(row.saved_timestamp) ?? new Date().toISOString()).replace(' ', 'T'),
      workingDays: int(row.working_days),
      lopDays: int(row.lop_days),
      daysPayable: int(row.days_payable),
      migratedFromLegacy: true,
    }

    const data = {
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      // generatedById is a plain column with no FK, so a missing saved_by
      // degrades to the subject rather than failing the row.
      generatedById: generatedById ?? employeeId,
    }
    const key = `${employeeId}:${fy}:${month}`
    const existingId = existing.get(key)
    if (existingId) {
      // A payslip is a document, not a total, so a second one for the same
      // month supersedes rather than adds to the first — but say so, because
      // the superseded figures are not carried anywhere.
      await tx.hrPayslip.update({ where: { id: existingId }, data })
      counter.updated += 1
      reporter.problem({
        legacyTable: 'payslip',
        legacyId,
        targetModel: 'HrPayslip',
        code: 'DUPLICATE_FOR_MONTH',
        field: null,
        value: `${fy} month ${month}`,
        message: 'Another payslip already covers this month; the later one replaces it.',
        action: 'REVIEW_REQUIRED',
      })
    } else {
      // A second legacy payslip for the same month, not yet written: replace
      // the pending record and report it, exactly as the already-in-database
      // branch above does, rather than pushing a duplicate into the batch.
      if (toCreate.has(key)) {
        counter.updated += 1
        reporter.problem({
          legacyTable: 'payslip',
          legacyId,
          targetModel: 'HrPayslip',
          code: 'DUPLICATE_FOR_MONTH',
          field: null,
          value: `${fy} month ${month}`,
          message: 'Another payslip already covers this month; the later one replaces it.',
          action: 'REVIEW_REQUIRED',
        })
      } else {
        counter.inserted += 1
      }
      toCreate.set(key, { ...data, employeeId, financialYear: fy, month })
    }
  }

  if (toCreate.size > 0) await tx.hrPayslip.createMany({ data: [...toCreate.values()] })
}

runMigration()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })

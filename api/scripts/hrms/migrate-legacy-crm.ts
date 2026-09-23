/**
 * Legacy CRM (CodeIgniter/MySQL, `c4tcrm`) → CrmLead/CrmContact/CrmLeadActivity.
 *
 *   npx tsx scripts/hrms/migrate-legacy-crm.ts --mode=dry-run
 *   npx tsx scripts/hrms/migrate-legacy-crm.ts --mode=full
 *
 * ── What this is, and is not
 *
 * A THIRD legacy source, distinct from both `scripts/migration` (the main
 * platform) and `migrate-legacy.ts` (the HR system) — a different MySQL
 * database on the same legacy host, with its own schema. Same shape as
 * `migrate-legacy.ts` throughout: SELECT-only connection, one transaction,
 * dry-run by default, a written report, nothing silently defaulted.
 *
 * ── The identity problem this data has
 *
 * Every lead and note is stamped with who added it, but as FREE TEXT — a
 * username ("hansil123") or, on older rows, a bare legacy user id ("24") —
 * never a foreign key. The legacy CRM's own `users` table today holds only
 * the 3 people still active in it (admin, Devi Madduri, Anil Kumar); of the
 * ~15 distinct authors who appear across 552 leads, only those 3 — and only
 * where their CURRENT username or user_id was used — resolve to anyone at
 * all. Cross-referencing by email into the TARGET HrEmployee table narrows it
 * further still: whichever of those 3 do not have an HR record yet resolve to
 * nobody either. Everyone else who authored a lead left Crowd4Test before
 * either system's "current roster" was what it is today, and nothing in this
 * database remembers who they were beyond that stamped string.
 *
 * `CrmLead.createdById` is a required relation, so every one of those rows
 * needs a real owner. Rather than inventing one, they fall to a single,
 * clearly-named system owner (whichever HrEmployee currently holds
 * `admin@crowd4test.com`) — and the original stamp is not thrown away: it is
 * kept verbatim in the row's own CREATED activity, in `meta.legacyAddedBy`,
 * so "who really added this" is still answerable by reading the timeline,
 * just not modelled as a real ownership relationship nothing backs up.
 * `assignedToId` gets the same treatment in reverse: it is only ever set to a
 * resolved real employee, and stays null (a real, filterable "unassigned")
 * for everyone else — an unattributed lead is not silently handed to admin.
 *
 * ── Two real bugs the raw schema would have produced if trusted as-is
 *
 * `notes.Company` is misnamed: despite the name, every value is `leads.id`
 * as a string, not a company name (confirmed — joining notes.Company against
 * leads.CompanyName matches nothing at all; casting it to an integer and
 * joining against leads.id matches 184 of 192). The 8 that still do not
 * match reference lead ids that no longer exist in `leads` at all — the
 * notes survived a lead being deleted from the legacy system at some point.
 * Those 8 are reported as orphans and skipped.
 *
 * `leads.gstin`/`reg_org_name`/`reg_org_address` are real fields but used on
 * exactly one row (id 489) — everything else is null. Not a bug, just worth
 * knowing before assuming they carry real data broadly.
 */
import 'dotenv/config'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { PrismaClient, CrmLeadStatus, CrmActivityKind, type Prisma } from '@prisma/client'
import { ISO_COUNTRY_CODES } from '../../src/lib/iso-countries.js'
import { Reporter } from '../migration/report/reporter.js'
import { text, url, email as emailOf, timestamp } from '../migration/transform/values.js'

// ── Source connection ────────────────────────────────────────────────────────

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required — see .env.example (LEGACY_CRM_DB_*).`)
  return value
}

const LEGACY = {
  host: required('LEGACY_CRM_DB_HOST'),
  port: Number(process.env.LEGACY_CRM_DB_PORT ?? 3306),
  user: required('LEGACY_CRM_DB_USER'),
  password: required('LEGACY_CRM_DB_PASSWORD'),
  database: required('LEGACY_CRM_DB_NAME'),
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

// ── Transforms derived from the live data ────────────────────────────────────

/**
 * The exact set of `leads.Country` spellings seen in this database, mapped to
 * ISO 3166-1 alpha-2. Hand-built rather than fuzzy-matched against a names
 * table: there are only 40 distinct values across 552 rows, so listing them
 * is both more precise and easier to audit than a similarity match that could
 * silently mis-map one.
 */
const COUNTRY_MAP: Record<string, string> = {
  afghanistan: 'AF',
  argentina: 'AR',
  australia: 'AU',
  bangladesh: 'BD',
  brazil: 'BR',
  cameroon: 'CM',
  canada: 'CA',
  chile: 'CL',
  egypt: 'EG',
  finland: 'FI',
  france: 'FR',
  germany: 'DE',
  'germany (deutschland)': 'DE',
  hungary: 'HU',
  iceland: 'IS',
  india: 'IN',
  indonesia: 'ID',
  ireland: 'IE',
  israel: 'IL',
  italy: 'IT',
  jordan: 'JO',
  lithuania: 'LT',
  mexico: 'MX',
  netherlands: 'NL',
  qatar: 'QA',
  'saudi arabia': 'SA',
  singapore: 'SG',
  'south africa': 'ZA',
  'spain (españa)': 'ES',
  'sri lanka': 'LK',
  sweden: 'SE',
  'taiwan, province of china': 'TW',
  thailand: 'TH',
  turkey: 'TR',
  uganda: 'UG',
  'united arab emirates': 'AE',
  'united kingdom': 'GB',
  'united states': 'US',
  usa: 'US',
  'viet nam': 'VN',
}

function mapCountry(value: unknown): string | null {
  const s = text(value)
  if (!s) return null
  const code = COUNTRY_MAP[s.toLowerCase()]
  if (code && ISO_COUNTRY_CODES.has(code)) return code
  return null
}

/** `leads`/`notes` real status vocabulary → the new module's fixed enum. */
const STATUS_MAP: Record<string, CrmLeadStatus> = {
  new: CrmLeadStatus.NEW,
  inprogress: CrmLeadStatus.QUALIFIED,
  completed: CrmLeadStatus.CLIENT,
  cancelled: CrmLeadStatus.LEAD_LOST,
  client: CrmLeadStatus.CLIENT,
  hot: CrmLeadStatus.HOT,
  // Real data has a stray trailing quote on this one value — both spellings map.
  "prospect'": CrmLeadStatus.PROSPECT,
  prospect: CrmLeadStatus.PROSPECT,
  warm: CrmLeadStatus.WARM,
  lost: CrmLeadStatus.LEAD_LOST,
  unqualified: CrmLeadStatus.UNQUALIFIED,
  shutdown: CrmLeadStatus.SHUTDOWN,
  cold: CrmLeadStatus.COLD,
}

function mapStatus(value: unknown): { value: CrmLeadStatus; unmapped: string | null } {
  const s = text(value)?.toLowerCase()
  if (!s) return { value: CrmLeadStatus.NEW, unmapped: null }
  const mapped = STATUS_MAP[s]
  return mapped ? { value: mapped, unmapped: null } : { value: CrmLeadStatus.NEW, unmapped: s }
}

/** "000", "00" and anything under 5 digits are placeholder junk, not a real number. */
function cleanPhone(value: unknown): string | null {
  const s = text(value)
  if (!s) return null
  const digits = s.replace(/[^0-9]/g, '')
  return digits.length >= 5 ? s : null
}

function cleanEmail(value: unknown): string | null {
  return emailOf(value).value
}

function cleanUrl(
  value: unknown,
  field: string,
  reporter: Reporter,
  legacyId: string,
): string | null {
  const s = text(value)
  if (!s) return null
  const { value: parsed, problem } = url(s, field)
  if (problem) {
    reporter.problem({
      legacyTable: 'leads',
      legacyId,
      targetModel: 'CrmLead',
      code: 'MALFORMED_URL',
      field: problem.field,
      value: problem.value,
      message: 'Website did not parse as a URL; left blank.',
      action: 'DEFAULTED',
    })
  }
  return parsed
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

class DryRunRollback extends Error {}

// ── The migration ────────────────────────────────────────────────────────────

const prisma = new PrismaClient()

interface LegacyData {
  leads: LegacyRow[]
  contacts: LegacyRow[]
  notes: LegacyRow[]
  users: LegacyRow[]
}

async function loadLegacy(source: LegacySource): Promise<LegacyData> {
  const [leads, contacts, notes, users] = await Promise.all([
    source.query('SELECT * FROM leads ORDER BY id'),
    source.query('SELECT * FROM contacts ORDER BY contact_id'),
    source.query('SELECT * FROM notes ORDER BY ID'),
    source.query('SELECT user_id, user_username, user_email FROM users'),
  ])
  return { leads, contacts, notes, users }
}

async function runMigration(): Promise<void> {
  const mode = parseMode(process.argv.slice(2))
  const reportDir = join(process.cwd(), 'migration-report-crm')
  const reporter = new Reporter(reportDir)
  const startedAt = new Date()

  const source = await LegacySource.connect()
  let legacy: LegacyData
  try {
    legacy = await loadLegacy(source)
  } finally {
    await source.close()
  }
  const totalRead = legacy.leads.length + legacy.contacts.length + legacy.notes.length
  console.log(`read ${totalRead} legacy rows (leads/contacts/notes); source connection closed.`)

  try {
    await prisma.$transaction(
      async (tx) => {
        await importAll(tx, legacy, reporter)
        if (mode === 'dry-run') throw new DryRunRollback()
      },
      // Generous for the same reason migrate-legacy.ts's is: 552 leads plus
      // their contacts and activity is small, but the connection may be
      // remote (WAN latency, not local-box round trips).
      { timeout: 900_000, maxWait: 30_000 },
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
        legacyTable: 'leads',
        disposition: 'NO_EQUIVALENT',
        notes:
          'companyLogo (21 rows): a filename on the legacy filesystem, unreachable over MySQL and with no field on CrmLead to hold it.',
      },
      {
        legacyTable: 'leads',
        disposition: 'NO_EQUIVALENT',
        notes: 'domain: empty on every row in this database; nothing to migrate.',
      },
      {
        legacyTable: 'users',
        disposition: 'DEPRECATED',
        notes:
          "The legacy CRM's own 3-user login table is not migrated — CRM has no separate identity system in the new module. Used read-only here to resolve authorship by email.",
      },
      {
        legacyTable: 'users_old',
        disposition: 'DEPRECATED',
        notes:
          'One vestigial row (the same admin, under an earlier scheme). No unique information.',
      },
      {
        legacyTable: 'events, invoices, invoice_line_items, partners, templates',
        disposition: 'OUT_OF_SCOPE',
        notes:
          'Not part of the CRM module this migration targets (leads, contacts, notes). Left untouched.',
      },
    ],
  })

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
): Promise<void> {
  const systemOwner = await tx.hrEmployee.findFirst({
    where: { email: 'admin@crowd4test.com', deletedAt: null },
    select: { id: true },
  })
  if (!systemOwner) {
    throw new Error(
      'No HrEmployee for admin@crowd4test.com in the target database — needed as the fallback owner for leads whose real legacy author no longer has an account anywhere. Seed the admin employee first.',
    )
  }

  // user_id/username → email, from the legacy CRM's own current 3-row roster.
  const emailByLegacyUserId = new Map<string, string>()
  const emailByLegacyUsername = new Map<string, string>()
  for (const row of legacy.users) {
    const userId = text(row.user_id)
    const username = text(row.user_username)?.toLowerCase()
    const email = text(row.user_email)?.toLowerCase()
    if (!email) continue
    if (userId) emailByLegacyUserId.set(userId, email)
    if (username) emailByLegacyUsername.set(username, email)
  }

  // email → target HrEmployee.id, resolved fresh so this adapts automatically
  // between dev (almost nobody matches) and production (more of the roster does).
  const targetEmployees = await tx.hrEmployee.findMany({
    where: { deletedAt: null },
    select: { id: true, email: true },
  })
  const employeeIdByEmail = new Map(targetEmployees.map((e) => [e.email.toLowerCase(), e.id]))

  /** A raw `AddedBY`/`AddedBy`-style stamp → a real target employee id, or null. */
  function resolveAuthor(raw: string | null): string | null {
    if (!raw) return null
    const trimmed = raw.trim()
    const byId = emailByLegacyUserId.get(trimmed)
    const byUsername = emailByLegacyUsername.get(trimmed.toLowerCase())
    const email = byId ?? byUsername
    return email ? (employeeIdByEmail.get(email) ?? null) : null
  }

  const industryByName = await importIndustries(tx, legacy.leads)

  const leadIdByLegacyId = await importLeads(
    tx,
    legacy.leads,
    reporter,
    industryByName,
    resolveAuthor,
    systemOwner.id,
  )
  await importEmbeddedContacts(tx, legacy.leads, reporter, leadIdByLegacyId)
  await importSeparateContacts(tx, legacy.contacts, reporter, leadIdByLegacyId)
  await importNotes(tx, legacy.notes, reporter, leadIdByLegacyId, resolveAuthor, systemOwner.id)
  await recomputeLastActivity(tx, leadIdByLegacyId)
}

// ── leads.industryType → CrmIndustry ─────────────────────────────────────────

async function importIndustries(
  tx: Prisma.TransactionClient,
  leads: LegacyRow[],
): Promise<Map<string, string>> {
  const names = new Set<string>()
  for (const row of leads) {
    const name = text(row.industryType)
    if (name) names.add(name)
  }

  const existing = await tx.crmIndustry.findMany({ select: { id: true, name: true } })
  const byName = new Map(existing.map((i) => [i.name, i.id]))

  const toCreate = [...names].filter((n) => !byName.has(n))
  if (toCreate.length > 0) {
    await tx.crmIndustry.createMany({
      data: toCreate.map((name) => ({ name })),
      skipDuplicates: true,
    })
    const created = await tx.crmIndustry.findMany({
      where: { name: { in: toCreate } },
      select: { id: true, name: true },
    })
    for (const c of created) byName.set(c.name, c.id)
  }

  return byName
}

// ── leads → CrmLead ───────────────────────────────────────────────────────────

async function importLeads(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  industryByName: Map<string, string>,
  resolveAuthor: (raw: string | null) => string | null,
  systemOwnerId: string,
): Promise<Map<string, string>> {
  const counter = reporter.counter('leads', 'CrmLead')
  const byLegacyId = new Map<string, string>()

  const existing = await tx.crmLead.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  })
  const existingByLegacyId = new Map(
    existing.filter((e) => e.legacyId).map((e) => [e.legacyId!, e.id]),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.id)
    const companyName = text(row.CompanyName)
    if (!companyName) {
      reporter.skip('leads', legacyId, 'CrmLead', 'NO_COMPANY_NAME', 'Row has no company name.')
      counter.skipped += 1
      continue
    }

    const { value: status, unmapped } = mapStatus(row.status)
    if (unmapped) {
      reporter.problem({
        legacyTable: 'leads',
        legacyId,
        targetModel: 'CrmLead',
        code: 'UNMAPPED_STATUS',
        field: 'status',
        value: unmapped,
        message: `Unrecognised status "${unmapped}"; defaulted to NEW.`,
        action: 'DEFAULTED',
      })
    }

    const industryId = (() => {
      const name = text(row.industryType)
      return name ? (industryByName.get(name) ?? null) : null
    })()

    const rawAddedBy = text(row.AddedBY)
    const assignedToId = resolveAuthor(rawAddedBy)
    if (rawAddedBy && !assignedToId) {
      reporter.problem({
        legacyTable: 'leads',
        legacyId,
        targetModel: 'CrmLead',
        code: 'AUTHOR_UNRESOLVED',
        field: 'AddedBY',
        value: rawAddedBy,
        message:
          "This author has no matching current HrEmployee (left before either system's current roster, or the account no longer exists) — left unassigned; createdBy falls to the system owner.",
        action: 'DEFAULTED',
      })
    }

    const data = {
      companyName,
      companySize: text(row.CompanySize),
      website: cleanUrl(row.WebsiteUrl, 'website', reporter, legacyId),
      industryId,
      countryCode: mapCountry(row.Country),
      location: text(row.location),
      registeredOrgName: text(row.reg_org_name),
      registeredAddress: text(row.reg_org_address),
      gstin: text(row.gstin)?.toUpperCase() ?? null,
      status,
      // 'Assigned' in the new module means real ownership; an unresolved
      // historical author is not the same thing as "assigned to nobody in
      // particular" being wrong to guess at, so this stays null rather than
      // falling to the system owner the way createdById does below.
      assignedToId,
      createdById: assignedToId ?? systemOwnerId,
      // The real historical date, not the migration's own clock — leads.date
      // is nullable in the legacy schema, hence the fallback.
      createdAt: timestamp(row.date) ?? new Date(),
      legacyId,
    }

    const existingId = existingByLegacyId.get(legacyId)
    if (existingId) {
      await tx.crmLead.update({ where: { id: existingId }, data })
      byLegacyId.set(legacyId, existingId)
      counter.updated += 1
    } else {
      const created = await tx.crmLead.create({ data, select: { id: true } })
      byLegacyId.set(legacyId, created.id)
      counter.inserted += 1
    }
    reporter.mapping({
      legacyTable: 'leads',
      legacyId,
      targetModel: 'CrmLead',
      targetId: byLegacyId.get(legacyId)!,
    })
  }

  return byLegacyId
}

// ── leads' two embedded contact slots → CrmContact ───────────────────────────

async function importEmbeddedContacts(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  leadIdByLegacyId: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('leads (embedded contacts)', 'CrmContact')
  const toCreate: Prisma.CrmContactCreateManyInput[] = []
  const existing = new Set(
    (
      await tx.crmContact.findMany({
        where: { legacyId: { not: null } },
        select: { legacyId: true },
      })
    ).map((c) => c.legacyId!),
  )

  for (const row of rows) {
    const legacyLeadId = String(row.id)
    const leadId = leadIdByLegacyId.get(legacyLeadId)
    if (!leadId) continue // the lead itself was skipped; nothing to attach to

    const slots: { suffix: '' | '_2'; legacySlot: 1 | 2 }[] = [
      { suffix: '', legacySlot: 1 },
      { suffix: '_2', legacySlot: 2 },
    ]
    for (const { suffix, legacySlot } of slots) {
      counter.read += 1
      const name = text(row[`ContactPerson${suffix}`])
      if (!name) {
        counter.skipped += 1
        continue
      }
      const contactLegacyId = `lead:${legacyLeadId}:${legacySlot}`
      if (existing.has(contactLegacyId)) {
        counter.updated += 1
        continue // contacts have no natural update source beyond the lead row; leave as first imported
      }
      toCreate.push({
        leadId,
        name,
        designation: text(row[`designation${suffix}`]),
        phone: cleanPhone(row[`Phone${suffix}`]),
        email: cleanEmail(row[`Email${suffix}`]),
        profileUrl: text(row[`ProfileUrl${suffix}`]),
        legacyId: contactLegacyId,
      })
      counter.inserted += 1
    }
  }

  if (toCreate.length > 0) await tx.crmContact.createMany({ data: toCreate })
}

// ── the separate `contacts` table → CrmContact ───────────────────────────────

async function importSeparateContacts(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  leadIdByLegacyId: Map<string, string>,
): Promise<void> {
  const counter = reporter.counter('contacts', 'CrmContact')
  const toCreate: Prisma.CrmContactCreateManyInput[] = []
  const existing = new Set(
    (
      await tx.crmContact.findMany({
        where: { legacyId: { not: null } },
        select: { legacyId: true },
      })
    ).map((c) => c.legacyId!),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.contact_id)
    const legacyLeadId = text(row.customer_id)
    const leadId = legacyLeadId ? leadIdByLegacyId.get(legacyLeadId) : undefined
    if (!leadId) {
      reporter.orphan({
        legacyTable: 'contacts',
        legacyId,
        field: 'customer_id',
        referencedTable: 'leads',
        referencedId: legacyLeadId ?? '',
      })
      reporter.skip(
        'contacts',
        legacyId,
        'CrmContact',
        'ORPHAN',
        'No migrated lead for this customer_id.',
      )
      counter.skipped += 1
      continue
    }

    const name = text(row.contact_person)
    if (!name) {
      reporter.skip('contacts', legacyId, 'CrmContact', 'NO_NAME', 'Row has no contact name.')
      counter.skipped += 1
      continue
    }

    const contactLegacyId = `contact:${legacyId}`
    if (existing.has(contactLegacyId)) {
      counter.updated += 1
      continue
    }
    toCreate.push({
      leadId,
      name,
      designation: text(row.designation),
      phone: cleanPhone(row.phone),
      email: cleanEmail(row.email),
      profileUrl: text(row.profile_url),
      legacyId: contactLegacyId,
    })
    counter.inserted += 1
  }

  if (toCreate.length > 0) await tx.crmContact.createMany({ data: toCreate })
}

// ── notes → CrmLeadActivity (NOTE), plus one CREATED event per lead ─────────

async function importNotes(
  tx: Prisma.TransactionClient,
  rows: LegacyRow[],
  reporter: Reporter,
  leadIdByLegacyId: Map<string, string>,
  resolveAuthor: (raw: string | null) => string | null,
  systemOwnerId: string,
): Promise<void> {
  const counter = reporter.counter('notes', 'CrmLeadActivity')
  const toCreate: Prisma.CrmLeadActivityCreateManyInput[] = []
  const existing = new Set(
    (
      await tx.crmLeadActivity.findMany({
        where: { legacyId: { not: null } },
        select: { legacyId: true },
      })
    ).map((a) => a.legacyId!),
  )

  for (const row of rows) {
    counter.read += 1
    const legacyId = String(row.ID)
    const body = text(row.notes)
    if (!body) {
      reporter.skip('notes', legacyId, 'CrmLeadActivity', 'NO_BODY', 'Row has no note text.')
      counter.skipped += 1
      continue
    }

    // Despite its name, `Company` holds `leads.id` as a string on every row —
    // see the file header. Not a company name; never treated as one.
    const legacyLeadId = text(row.Company)
    const leadId = legacyLeadId ? leadIdByLegacyId.get(legacyLeadId) : undefined
    if (!leadId) {
      reporter.orphan({
        legacyTable: 'notes',
        legacyId,
        field: 'Company',
        referencedTable: 'leads',
        referencedId: legacyLeadId ?? '',
      })
      reporter.skip(
        'notes',
        legacyId,
        'CrmLeadActivity',
        'ORPHAN',
        'The lead this note names no longer exists in `leads`.',
      )
      counter.skipped += 1
      continue
    }

    const activityLegacyId = `note:${legacyId}`
    if (existing.has(activityLegacyId)) {
      counter.updated += 1
      continue
    }

    const rawAddedBy = text(row.AddedBy)
    const employeeId = resolveAuthor(rawAddedBy) ?? systemOwnerId
    const meta: Record<string, unknown> = {}
    if (rawAddedBy) meta.legacyAddedBy = rawAddedBy
    const statusAtTime = text(row.leadStatus)
    if (statusAtTime) meta.legacyStatusAtTime = statusAtTime

    toCreate.push({
      leadId,
      employeeId,
      kind: CrmActivityKind.NOTE,
      body,
      meta: Object.keys(meta).length > 0 ? (meta as Prisma.InputJsonValue) : undefined,
      // AddedON is nullable in the legacy schema; a raw `new Date(String(...))`
      // on a null row produces an Invalid Date, which Prisma rejects with an
      // error naming neither the row nor the column — caught by a dry run
      // before this ever wrote anything.
      createdAt: timestamp(row.AddedON) ?? new Date(),
      legacyId: activityLegacyId,
    })
    counter.inserted += 1
  }

  if (toCreate.length > 0) await tx.crmLeadActivity.createMany({ data: toCreate })

  // One CREATED event per migrated lead — the timeline's own starting point,
  // matching what a lead created through the API gets automatically.
  const createdCounter = reporter.counter('leads (created event)', 'CrmLeadActivity')
  const createdExisting = new Set(
    (
      await tx.crmLeadActivity.findMany({
        where: { kind: CrmActivityKind.CREATED, legacyId: { not: null } },
        select: { legacyId: true },
      })
    ).map((a) => a.legacyId!),
  )
  const createdToCreate: Prisma.CrmLeadActivityCreateManyInput[] = []
  const leads = await tx.crmLead.findMany({
    where: { legacyId: { in: [...leadIdByLegacyId.keys()] } },
    select: { id: true, legacyId: true, createdAt: true },
  })
  for (const lead of leads) {
    createdCounter.read += 1
    const activityLegacyId = `created:${lead.legacyId}`
    if (createdExisting.has(activityLegacyId)) {
      createdCounter.updated += 1
      continue
    }
    createdToCreate.push({
      leadId: lead.id,
      employeeId: systemOwnerId,
      kind: CrmActivityKind.CREATED,
      createdAt: lead.createdAt,
      legacyId: activityLegacyId,
    })
    createdCounter.inserted += 1
  }
  if (createdToCreate.length > 0) await tx.crmLeadActivity.createMany({ data: createdToCreate })
}

// ── lastActivityAt = MAX(activity.createdAt) per migrated lead ──────────────

async function recomputeLastActivity(
  tx: Prisma.TransactionClient,
  leadIdByLegacyId: Map<string, string>,
): Promise<void> {
  const leadIds = [...leadIdByLegacyId.values()]
  const activity = await tx.crmLeadActivity.groupBy({
    by: ['leadId'],
    where: { leadId: { in: leadIds } },
    _max: { createdAt: true },
  })
  for (const row of activity) {
    if (!row._max.createdAt) continue
    await tx.crmLead.update({
      where: { id: row.leadId },
      data: { lastActivityAt: row._max.createdAt },
    })
  }
}

runMigration()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })

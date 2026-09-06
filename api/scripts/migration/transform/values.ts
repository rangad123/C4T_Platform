/**
 * MySQL → PostgreSQL value coercion.
 *
 * Every legacy oddity that would otherwise become a silent corruption gets a
 * named function here, so the migration's judgement calls are in one file and
 * can be argued with.
 */

/** Reported alongside a value the loader refused to guess at. */
export interface Problem {
  field: string
  value: string
  problem: string
}

// ── Text ─────────────────────────────────────────────────────────────────────

/**
 * Trims, and collapses MySQL's several spellings of "nothing" to null.
 *
 * The legacy schema uses `DEFAULT ''` on columns the new schema models as
 * nullable (`org_image`, `project_testdata`, `usr_profile_pic`). Carrying the
 * empty string over would turn "no logo" into "a logo whose filename is the
 * empty string", which reads as present to every `?? ` and `if (x)` downstream.
 */
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = asText(value).trim()
  if (s === '' || s === 'NULL' || s === 'null') return null
  return s
}

/** Text that must exist. Returns the fallback rather than throwing. */
export function requiredText(value: unknown, fallback: string): string {
  return text(value) ?? fallback
}

/**
 * Truncates to a destination limit, reporting rather than silently cutting.
 *
 * The brief is explicit that data must not be lost to a narrower column
 * without being told about it, so the caller gets the shortened value AND a
 * problem to write into `invalid_records.csv`.
 */
export function clamp(
  value: string | null,
  max: number,
  field: string,
): { value: string | null; problem: Problem | null } {
  if (value === null || value.length <= max) return { value, problem: null }
  return {
    value: value.slice(0, max),
    problem: {
      field,
      value: `${value.slice(0, 40)}… (${value.length} chars)`,
      problem: `exceeds destination limit of ${max}; truncated`,
    },
  }
}

// ── Dates ────────────────────────────────────────────────────────────────────

/**
 * MySQL's zero date. `0000-00-00 00:00:00` is a legal MariaDB value and not a
 * legal instant; `new Date()` turns it into `Invalid Date`, which Prisma then
 * rejects mid-batch with an error that names neither the row nor the column.
 */
const ZERO_DATE = /^0000-00-00([ T]00:00:00)?$/

/**
 * Parses a legacy timestamp as UTC.
 *
 * The dump sets `time_zone = "+00:00"`, and `client.ts` reads timestamps as
 * strings precisely so the driver cannot reinterpret them in the operator's
 * local zone. Appending `Z` is what makes "2019-04-02 11:15:00" mean the
 * instant it meant in the legacy system, on any machine the migration runs on.
 */
/**
 * Bounds for treating a bare number as a Unix epoch: 1990-01-01 to 2100-01-01.
 * Below the floor the value is far likelier to be an id or a count than a
 * date, and the legacy platform did not exist before 2013.
 */
const EPOCH_MIN_SECONDS = 631_152_000
const EPOCH_MAX_SECONDS = 4_102_444_800

export function timestamp(value: unknown): Date | null {
  const s = text(value)
  if (s === null) return null
  if (ZERO_DATE.test(s)) return null

  /*
    Not every legacy date is a date. `payment_history.pmt_time` and
    `payment_acc_details.pmt_timestamp` are `bigint` holding Unix epoch
    seconds — the PHP wrote `time()` straight into the column. Parsed as a
    string, "1442027582" is not a date at all, so the caller fell back to
    `now()` and stamped every transaction with the migration's own clock.

    Milliseconds are accepted too: the same codebase used `time()` in some
    places and JavaScript's `Date.now()` in others.
  */
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n >= EPOCH_MIN_SECONDS && n <= EPOCH_MAX_SECONDS) return new Date(n * 1000)
    if (n >= EPOCH_MIN_SECONDS * 1000 && n <= EPOCH_MAX_SECONDS * 1000) return new Date(n)
    return null
  }

  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const date = new Date(withZone)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A timestamp that must exist — falls back to another, then to `now`. */
export function timestampOr(value: unknown, ...fallbacks: unknown[]): Date {
  const primary = timestamp(value)
  if (primary) return primary
  for (const f of fallbacks) {
    if (f instanceof Date) return f
    const parsed = timestamp(f)
    if (parsed) return parsed
  }
  return new Date()
}

// ── Booleans ─────────────────────────────────────────────────────────────────

const TRUTHY = new Set(['1', 'y', 'yes', 'true', 't', 'active', 'verified', 'on', 'enabled'])
const FALSEY = new Set(['0', 'n', 'no', 'false', 'f', 'inactive', 'rejected', 'off', 'disabled'])

/**
 * The legacy schema spells booleans at least four ways — `tinyint(1)`,
 * `enum('yes','no')`, `enum('active','inactive')` and `enum('verified',
 * 'rejected')`. All of them arrive here.
 */
export function bool(value: unknown, fallback = false): boolean {
  const s = text(value)?.toLowerCase()
  if (s === null || s === undefined) return fallback
  if (TRUTHY.has(s)) return true
  if (FALSEY.has(s)) return false
  return fallback
}

// ── Numbers ──────────────────────────────────────────────────────────────────

export function int(value: unknown): number | null {
  const s = text(value)
  if (s === null) return null
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

export function intOr(value: unknown, fallback: number): number {
  return int(value) ?? fallback
}

/**
 * Money, as minor units.
 *
 * The legacy columns are `double` (`usr_account_balance`) and `varchar`
 * (`credit_rate`, `test_manager_fee`) — both wrong for currency, and the reason
 * the new schema uses `BigInt` minor units. Rounding happens once, here, rather
 * than drifting across float arithmetic in three different transformers.
 */
export function amountToMinor(value: unknown): bigint | null {
  const s = text(value)
  if (s === null) return null
  const cleaned = s.replace(/[^0-9.,-]/g, '').replace(/,/g, '')
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n)) return null
  return BigInt(Math.round(n * 100))
}

// ── Legacy foreign keys ──────────────────────────────────────────────────────

/**
 * A legacy integer id, as the string `MigrationRecordMap` keys on.
 *
 * Zero is not an id. The legacy schema uses `DEFAULT 0` on
 * `project_os_id`, `project_test_type_id` and `project_pricing_model_id` to
 * mean "unset", so `0` must read as absent or every project claims a
 * relationship to whatever row happens to be first.
 */
export function legacyRef(value: unknown): string | null {
  const s = text(value)
  if (s === null) return null
  if (s === '0') return null
  return s
}

/**
 * Splits a legacy list column into trimmed values.
 *
 * `project_devices`, `project_browsers`, `usr_skill_set`, `ast_devices` and
 * friends are `varchar(500)` holding comma-separated ids or names. The new
 * schema models these as `String[]` or as real join rows, so they have to be
 * parsed rather than carried across as one string.
 *
 * Handles the separators actually seen in dumps of this era: comma, semicolon
 * and pipe. Deduplicates, because legacy multi-selects frequently double up.
 */
export function list(value: unknown): string[] {
  const s = text(value)
  if (s === null) return []

  // A JSON array is possible where a later PHP version wrote the column.
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s)
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map((v) => String(v).trim()).filter(Boolean))]
      }
    } catch {
      // Fall through to separator splitting.
    }
  }

  return [
    ...new Set(
      s
        .split(/[,;|]/)
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ]
}

// ── Identity ─────────────────────────────────────────────────────────────────

/** RFC-shaped enough for a migration. The API validates properly on write. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function email(value: unknown): { value: string | null; problem: Problem | null } {
  const s = text(value)?.toLowerCase() ?? null
  if (s === null) {
    return { value: null, problem: { field: 'email', value: '', problem: 'missing' } }
  }
  if (!EMAIL.test(s)) {
    return { value: null, problem: { field: 'email', value: s, problem: 'malformed email' } }
  }
  return { value: s, problem: null }
}

/**
 * ISO 3166-1 alpha-2, or null.
 *
 * `usr_country` is `varchar(50)` and holds names ("India"), codes ("IN") and
 * junk interchangeably. `iso-countries.ts` already owns the authoritative code
 * set for the API, so this defers to it rather than inventing a second list.
 */
export function countryCode(
  value: unknown,
  isValidCode: (code: string) => boolean,
  byName: (name: string) => string | null,
): { value: string | null; problem: Problem | null } {
  const s = text(value)
  if (s === null) return { value: null, problem: null }

  const upper = s.toUpperCase()
  if (upper.length === 2 && isValidCode(upper)) return { value: upper, problem: null }

  const resolved = byName(s)
  if (resolved) return { value: resolved, problem: null }

  return {
    value: null,
    problem: { field: 'countryCode', value: s, problem: 'unrecognised country' },
  }
}

/** A URL the new schema will accept, or null plus a problem. */
export function url(
  value: unknown,
  field: string,
): { value: string | null; problem: Problem | null } {
  const s = text(value)
  if (s === null) return { value: null, problem: null }
  const candidate = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try {
    return { value: new URL(candidate).toString(), problem: null }
  } catch {
    return { value: null, problem: { field, value: s, problem: 'malformed URL' } }
  }
}

// ── Enums ────────────────────────────────────────────────────────────────────

/**
 * Maps a legacy value onto a destination enum, case- and space-insensitively.
 *
 * Returns the fallback AND a problem when the value is unrecognised, so an
 * enum member the dump never documented shows up in the report instead of
 * quietly becoming the default.
 */
export function enumValue<T extends string>(
  value: unknown,
  table: Record<string, T>,
  fallback: T,
  field: string,
): { value: T; problem: Problem | null } {
  const s = text(value)
  if (s === null) return { value: fallback, problem: null }

  const key = s.toLowerCase().replace(/[\s-]+/g, '_')
  const hit = table[key]
  if (hit) return { value: hit, problem: null }

  return {
    value: fallback,
    problem: { field, value: s, problem: `unmapped value; defaulted to ${fallback}` },
  }
}

/** Strips anything that would make a slug ambiguous. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A legacy cell rendered for a REPORT, never for storage.
 *
 * `String(row.some_column)` is what the reporting paths reached for, and on a
 * `Record<string, unknown>` that is a promise to print `[object Object]` the
 * first time a driver hands back a Buffer or a Date instead of a scalar — in
 * the orphan and invalid-record CSVs, which exist precisely so a human can
 * chase the value down. Anything that is not a scalar is described by its
 * type instead, which is at least true.
 */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  if (value instanceof Date) return value.toISOString()
  /*
    Narrowed explicitly rather than falling through to `String(value)`. A
    symbol throws on template interpolation, and an object stringifies to
    `[object Object]` — the exact outcome this function exists to prevent. Both
    are described by what they are instead.
  */
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'object') return `[${value.constructor.name}]`
  return '[unprintable]'
}

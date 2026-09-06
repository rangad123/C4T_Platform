import mysql from 'mysql2/promise'
import { migrationEnv } from '../config.js'
import { asText } from '../transform/values.js'

/**
 * Read-only access to the legacy MariaDB.
 *
 * ── EVERY QUERY HERE IS A SELECT
 *
 * `query()` refuses anything else. That is a seatbelt, not a security boundary
 * — the real guarantee is a MySQL account granted SELECT and nothing more, and
 * MIGRATION.md tells the operator to create one. But a typo in a transformer
 * should never be able to write to the system of record we are migrating away
 * from, and this catches that at the point it would happen.
 *
 * ── WHY `dateStrings`
 *
 * mysql2 converts DATETIME to a JavaScript Date using the *driver's* timezone,
 * which silently shifts every historical timestamp when the migration runs on a
 * laptop in +05:30. The legacy dump sets `time_zone = "+00:00"`, so the stored
 * values are UTC; we read them as raw strings and attach UTC ourselves in
 * `transform/dates.ts`. Getting this wrong moves ten years of bug reports by a
 * few hours, invisibly.
 *
 * `supportBigNumbers` + `bigNumberStrings` keep `int(11)` ids exact as strings,
 * which is also the shape `MigrationRecordMap.legacyId` stores.
 */

let pool: mysql.Pool | null = null

export function legacyPool(): mysql.Pool {
  if (pool) return pool
  const env = migrationEnv()
  pool = mysql.createPool({
    host: env.LEGACY_DB_HOST,
    port: env.LEGACY_DB_PORT,
    database: env.LEGACY_DB_NAME,
    user: env.LEGACY_DB_USER,
    password: env.LEGACY_DB_PASSWORD,
    charset: env.LEGACY_DB_CHARSET,
    connectionLimit: 4,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // A migration is a batch job; a stalled read should surface, not hang.
    connectTimeout: 20_000,
  })
  return pool
}

export async function closeLegacyPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

export type LegacyRow = Record<string, unknown>

const SELECT_ONLY = /^\s*(select|show|describe|explain)\b/i

export async function query<T = LegacyRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!SELECT_ONLY.test(sql)) {
    throw new Error(`Refusing to run a non-SELECT statement against the legacy database:\n${sql}`)
  }
  const [rows] = await legacyPool().query(sql, params)
  return rows as T[]
}

/** True when the legacy database actually has this table. */
export async function tableExists(table: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = ? AND table_name = ?`,
    [migrationEnv().LEGACY_DB_NAME, table],
  )
  return Number(rows[0]?.n ?? 0) > 0
}

/** Column names actually present, so a transformer can tolerate dump drift. */
export async function columnsOf(table: string): Promise<string[]> {
  const rows = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? ORDER BY ORDINAL_POSITION`,
    [migrationEnv().LEGACY_DB_NAME, table],
  )
  return rows.map((r) => r.COLUMN_NAME)
}

export async function countRows(table: string): Promise<number> {
  const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${table}\``)
  return Number(rows[0]?.n ?? 0)
}

/**
 * Streams a table in primary-key order, one batch at a time.
 *
 * KEYSET, NOT OFFSET. `LIMIT ? OFFSET ?` re-scans from the top on every page,
 * so the last page of a 200k-row table costs 200k rows of work; worse, on a
 * live source a concurrent insert shifts the window and rows get read twice or
 * skipped. Seeking on the primary key is stable and flat.
 *
 * The generator shape matters too: the caller processes and discards each batch
 * before the next is fetched, so peak memory is one batch regardless of table
 * size.
 */
export async function* batches(
  table: string,
  pk: string,
  options: { batchSize: number; limit?: number },
): AsyncGenerator<LegacyRow[]> {
  let cursor: string | null = null
  let yielded = 0

  for (;;) {
    const remaining = options.limit ? options.limit - yielded : Number.POSITIVE_INFINITY
    if (remaining <= 0) return
    const size = Math.min(options.batchSize, remaining)

    const rows: LegacyRow[] = cursor
      ? await query(
          `SELECT * FROM \`${table}\` WHERE \`${pk}\` > ? ORDER BY \`${pk}\` ASC LIMIT ${size}`,
          [cursor],
        )
      : await query(`SELECT * FROM \`${table}\` ORDER BY \`${pk}\` ASC LIMIT ${size}`)

    if (rows.length === 0) return

    yield rows
    yielded += rows.length

    const last = rows[rows.length - 1]
    const next = last?.[pk]
    if (next === undefined || next === null) return
    cursor = asText(next)

    if (rows.length < size) return
  }
}

/**
 * Tables with no usable primary key (`ci_sessions`) still need counting during
 * a dry run, but are never streamed — nothing depends on their contents.
 */
export async function sampleRows(table: string, limit: number): Promise<LegacyRow[]> {
  return query(`SELECT * FROM \`${table}\` LIMIT ${Number(limit)}`)
}

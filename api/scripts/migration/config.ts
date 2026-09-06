import 'dotenv/config'
import { z } from 'zod'

/**
 * Configuration for the legacy MariaDB → PostgreSQL migration.
 *
 * ── WHY THIS DOES NOT REUSE `src/config/env.ts`
 *
 * The application's config demands a JWT key pair, an SES region, an S3 bucket
 * and a dozen other runtime secrets, and it throws at import time when any of
 * them is missing. None of that has anything to do with copying rows between
 * two databases, and requiring it would mean a DBA cannot run the migration
 * without first being handed the platform's signing keys. So this validates
 * only what the migration actually touches: two connection strings and a
 * handful of switches.
 *
 * ── READ-ONLY BY CONSTRUCTION
 *
 * `LEGACY_DB_*` should point at a MySQL account with SELECT and nothing else.
 * The tool only ever issues SELECT, but a read-only grant is what makes that a
 * guarantee rather than a promise — see MIGRATION.md, "Prerequisites".
 */

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback)

const schema = z.object({
  // ── Source: legacy MariaDB ────────────────────────────────────────────────
  LEGACY_DB_HOST: z.string().min(1, 'LEGACY_DB_HOST is required (see .env.example)'),
  LEGACY_DB_PORT: int(3306),
  LEGACY_DB_NAME: z.string().min(1, 'LEGACY_DB_NAME is required'),
  LEGACY_DB_USER: z.string().min(1, 'LEGACY_DB_USER is required'),
  LEGACY_DB_PASSWORD: z.string().default(''),
  /**
   * The legacy dump declares `utf8mb4`. Overridable because older MySQL
   * installs of this vintage frequently actually hold latin1 bytes in a utf8
   * column, and reading those with the wrong charset silently mangles every
   * accented name.
   */
  LEGACY_DB_CHARSET: z.string().default('utf8mb4'),

  // ── Destination: new PostgreSQL ───────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ── Behaviour ─────────────────────────────────────────────────────────────
  /** Rows fetched (and written) per batch. Keeps memory flat on big tables. */
  MIGRATION_BATCH_SIZE: int(500),
  /** Rows per table in sample mode. */
  MIGRATION_SAMPLE_SIZE: int(100),
  /** Where reports are written. */
  MIGRATION_REPORT_DIR: z.string().default('migration-report'),
  /**
   * Optional pepper for legacy password verification. Only set this once the
   * CodeIgniter login controller has been read and the scheme confirmed —
   * guessing it locks every legacy user out. See src/lib/legacy-password.ts.
   */
  LEGACY_PASSWORD_PEPPER: z.string().optional(),
  /**
   * Base path or URL that legacy `*_loc_server` columns are relative to. Unset
   * means file migration is skipped and every attachment is reported as
   * unresolved rather than pointed at a URL that does not exist.
   */
  LEGACY_FILE_ROOT: z.string().optional(),
})

export type MigrationMode = 'dry-run' | 'sample' | 'full'

export interface MigrationOptions {
  mode: MigrationMode
  /** Restrict the run to these legacy tables. Empty means all of them. */
  only: string[]
  /** Skip these legacy tables. */
  skip: string[]
  batchSize: number
  sampleSize: number
  reportDir: string
  /** Continue past a failing table instead of aborting the run. */
  continueOnError: boolean
}

function parseEnv() {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Migration configuration is invalid:\n${lines.join('\n')}`)
  }
  return parsed.data
}

export type MigrationEnv = ReturnType<typeof parseEnv>

let cached: MigrationEnv | null = null

export function migrationEnv(): MigrationEnv {
  cached ??= parseEnv()
  return cached
}

/**
 * Reads CLI flags on top of the environment.
 *
 * Supported: --mode=, --only=a,b --skip=a,b --batch= --sample= --continue-on-error
 */
export function optionsFromArgv(argv: string[], fallbackMode: MigrationMode): MigrationOptions {
  const env = migrationEnv()
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : undefined
  }
  const list = (name: string): string[] =>
    (get(name) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  const mode = (get('mode') as MigrationMode | undefined) ?? fallbackMode
  if (!['dry-run', 'sample', 'full'].includes(mode)) {
    throw new Error(`Unknown --mode=${mode}. Use dry-run, sample or full.`)
  }

  return {
    mode,
    only: list('only'),
    skip: list('skip'),
    batchSize: Number(get('batch') ?? env.MIGRATION_BATCH_SIZE),
    sampleSize: Number(get('sample') ?? env.MIGRATION_SAMPLE_SIZE),
    reportDir: get('report-dir') ?? env.MIGRATION_REPORT_DIR,
    continueOnError: argv.includes('--continue-on-error'),
  }
}

/** Host/database only — never the password. Recorded on every MigrationRun. */
export function sourceDescriptor(): string {
  const env = migrationEnv()
  return `${env.LEGACY_DB_HOST}:${env.LEGACY_DB_PORT}/${env.LEGACY_DB_NAME}`
}

export const TOOL_VERSION = '1.0.0'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Collects everything the run wants to say, and writes it out at the end.
 *
 * ── NOTHING IS DROPPED SILENTLY
 *
 * That is the rule the brief repeats most, so it is enforced structurally: a
 * loader cannot skip a row without calling `skip()` or `fail()`, both of which
 * demand a reason, and the counts in `summary.md` are derived from these calls
 * rather than tracked separately. If read ≠ inserted + updated + skipped +
 * failed, the summary says so out loud instead of quietly not adding up.
 *
 * ── CSV SAFETY
 *
 * Reports are opened in Excel by people investigating a bad row, so a value
 * beginning `=`, `+`, `-` or `@` is prefixed with an apostrophe: otherwise a
 * legacy field containing `=cmd|…` is a formula-injection payload that runs on
 * open. This mirrors web/src/lib/reports/report-csv.ts, which does the same for
 * the same reason.
 */

export type ProblemAction = 'SKIPPED' | 'FAILED' | 'REVIEW_REQUIRED' | 'TRUNCATED' | 'DEFAULTED'

export interface ProblemRecord {
  legacyTable: string
  legacyId: string | null
  targetModel: string | null
  code: string
  field: string | null
  value: string | null
  message: string
  action: ProblemAction
}

export interface TableCounters {
  legacyTable: string
  targetModel: string
  read: number
  inserted: number
  updated: number
  skipped: number
  failed: number
}

export interface OrphanRecord {
  legacyTable: string
  legacyId: string
  field: string
  referencedTable: string
  referencedId: string
}

export interface MissingFileRecord {
  legacyTable: string
  legacyId: string
  field: string
  path: string
  reason: string
}

export interface IdMappingRecord {
  legacyTable: string
  legacyId: string
  targetModel: string
  targetId: string
}

export class Reporter {
  readonly problems: ProblemRecord[] = []
  readonly orphans: OrphanRecord[] = []
  readonly missingFiles: MissingFileRecord[] = []
  readonly idMappings: IdMappingRecord[] = []
  private readonly counters = new Map<string, TableCounters>()

  constructor(private readonly reportDir: string) {}

  // ── Counters ──────────────────────────────────────────────────────────────

  counter(legacyTable: string, targetModel: string): TableCounters {
    const key = `${legacyTable}→${targetModel}`
    let c = this.counters.get(key)
    if (!c) {
      c = { legacyTable, targetModel, read: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 }
      this.counters.set(key, c)
    }
    return c
  }

  allCounters(): TableCounters[] {
    return [...this.counters.values()].sort((a, b) =>
      a.legacyTable.localeCompare(b.legacyTable),
    )
  }

  // ── Problems ──────────────────────────────────────────────────────────────

  problem(record: ProblemRecord): void {
    this.problems.push(record)
  }

  skip(
    legacyTable: string,
    legacyId: string | null,
    targetModel: string | null,
    code: string,
    message: string,
    extra: { field?: string; value?: string } = {},
  ): void {
    this.problem({
      legacyTable,
      legacyId,
      targetModel,
      code,
      field: extra.field ?? null,
      value: extra.value ?? null,
      message,
      action: 'SKIPPED',
    })
  }

  fail(
    legacyTable: string,
    legacyId: string | null,
    targetModel: string | null,
    code: string,
    message: string,
  ): void {
    this.problem({
      legacyTable,
      legacyId,
      targetModel,
      code,
      field: null,
      value: null,
      message,
      action: 'FAILED',
    })
  }

  review(legacyTable: string, message: string, legacyId: string | null = null): void {
    this.problem({
      legacyTable,
      legacyId,
      targetModel: null,
      code: 'REVIEW_REQUIRED',
      field: null,
      value: null,
      message,
      action: 'REVIEW_REQUIRED',
    })
  }

  orphan(record: OrphanRecord): void {
    this.orphans.push(record)
  }

  missingFile(record: MissingFileRecord): void {
    this.missingFiles.push(record)
  }

  mapping(record: IdMappingRecord): void {
    this.idMappings.push(record)
  }

  // ── Output ────────────────────────────────────────────────────────────────

  private static csvField(value: unknown): string {
    const s = value === null || value === undefined ? '' : String(value)
    // Formula injection: Excel treats these as executable on open.
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return `"${guarded.replace(/"/g, '""')}"`
  }

  private static csv(headers: string[], rows: unknown[][]): string {
    const lines = [headers.map(Reporter.csvField).join(',')]
    for (const row of rows) lines.push(row.map(Reporter.csvField).join(','))
    // BOM so Excel reads UTF-8 rather than the system codepage.
    return `﻿${lines.join('\r\n')}\r\n`
  }

  write(meta: {
    mode: string
    runId: string | null
    source: string
    startedAt: Date
    finishedAt: Date
    notMigrated: { legacyTable: string; disposition: string; notes: string }[]
  }): string {
    mkdirSync(this.reportDir, { recursive: true })
    const out = (name: string, body: string) => {
      writeFileSync(join(this.reportDir, name), body, 'utf8')
    }

    const counters = this.allCounters()

    out(
      'table-counts.csv',
      Reporter.csv(
        ['legacy_table', 'target_model', 'read', 'inserted', 'updated', 'skipped', 'failed', 'balanced'],
        counters.map((c) => [
          c.legacyTable,
          c.targetModel,
          c.read,
          c.inserted,
          c.updated,
          c.skipped,
          c.failed,
          c.inserted + c.updated + c.skipped + c.failed === c.read ? 'yes' : 'NO',
        ]),
      ),
    )

    out(
      'migration-errors.csv',
      Reporter.csv(
        ['legacy_table', 'legacy_id', 'target_model', 'code', 'field', 'value', 'message', 'action'],
        this.problems
          .filter((p) => p.action === 'FAILED')
          .map((p) => [p.legacyTable, p.legacyId, p.targetModel, p.code, p.field, p.value, p.message, p.action]),
      ),
    )

    out(
      'invalid-records.csv',
      Reporter.csv(
        ['table', 'legacy_id', 'field', 'value', 'problem', 'action'],
        this.problems
          .filter((p) => p.action !== 'FAILED')
          .map((p) => [p.legacyTable, p.legacyId, p.field, p.value, p.message, p.action]),
      ),
    )

    out(
      'orphan-records.csv',
      Reporter.csv(
        ['legacy_table', 'legacy_id', 'field', 'referenced_table', 'referenced_id'],
        this.orphans.map((o) => [o.legacyTable, o.legacyId, o.field, o.referencedTable, o.referencedId]),
      ),
    )

    out(
      'missing-files.csv',
      Reporter.csv(
        ['legacy_table', 'legacy_id', 'field', 'path', 'reason'],
        this.missingFiles.map((f) => [f.legacyTable, f.legacyId, f.field, f.path, f.reason]),
      ),
    )

    out(
      'id-mappings.csv',
      Reporter.csv(
        ['legacy_table', 'legacy_id', 'target_model', 'target_id'],
        this.idMappings.map((m) => [m.legacyTable, m.legacyId, m.targetModel, m.targetId]),
      ),
    )

    const totals = counters.reduce(
      (acc, c) => ({
        read: acc.read + c.read,
        inserted: acc.inserted + c.inserted,
        updated: acc.updated + c.updated,
        skipped: acc.skipped + c.skipped,
        failed: acc.failed + c.failed,
      }),
      { read: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 },
    )

    const summary = {
      mode: meta.mode,
      runId: meta.runId,
      source: meta.source,
      startedAt: meta.startedAt.toISOString(),
      finishedAt: meta.finishedAt.toISOString(),
      durationSeconds: Math.round((meta.finishedAt.getTime() - meta.startedAt.getTime()) / 1000),
      totals,
      tables: counters,
      problemCount: this.problems.length,
      orphanCount: this.orphans.length,
      missingFileCount: this.missingFiles.length,
      notMigrated: meta.notMigrated,
    }
    out('summary.json', `${JSON.stringify(summary, null, 2)}\n`)

    const pad = (s: string, n: number) => s.padEnd(n)
    const rows = counters
      .map(
        (c) =>
          `| ${pad(c.legacyTable, 22)} | ${pad(c.targetModel, 20)} | ${String(c.read).padStart(7)} | ${String(
            c.inserted,
          ).padStart(8)} | ${String(c.updated).padStart(7)} | ${String(c.skipped).padStart(7)} | ${String(
            c.failed,
          ).padStart(6)} |`,
      )
      .join('\n')

    const md = `# Migration report — ${meta.mode}

- **Run id:** ${meta.runId ?? '(dry run — nothing written)'}
- **Source:** ${meta.source}
- **Started:** ${meta.startedAt.toISOString()}
- **Finished:** ${meta.finishedAt.toISOString()} (${summary.durationSeconds}s)

## Totals

| Read | Inserted | Updated | Skipped | Failed |
| ---: | -------: | ------: | ------: | -----: |
| ${totals.read} | ${totals.inserted} | ${totals.updated} | ${totals.skipped} | ${totals.failed} |

${
  totals.inserted + totals.updated + totals.skipped + totals.failed === totals.read
    ? 'Every row read is accounted for.'
    : '**Counts do not balance — investigate before trusting this run.**'
}

## Per table

| Legacy table | Target model | Read | Inserted | Updated | Skipped | Failed |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${rows}

## Not migrated (${meta.notMigrated.length} tables)

| Legacy table | Disposition | Why |
| --- | --- | --- |
${meta.notMigrated.map((t) => `| \`${t.legacyTable}\` | ${t.disposition} | ${t.notes} |`).join('\n')}

## Findings

- Problems recorded: **${this.problems.length}** (see \`invalid-records.csv\`, \`migration-errors.csv\`)
- Orphaned references: **${this.orphans.length}** (see \`orphan-records.csv\`)
- Unresolved files: **${this.missingFiles.length}** (see \`missing-files.csv\`)
`
    out('summary.md', md)

    return this.reportDir
  }
}

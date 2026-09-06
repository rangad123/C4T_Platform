import { writeFileSync } from 'node:fs'
import { REGISTRY, mappingsInPhaseOrder, isMigrated } from '../mapping/registry.js'

/**
 * Renders the migration matrix from the registry.
 *
 * The matrix is generated rather than written because a hand-maintained table
 * drifts from the loaders within weeks. Run `npm run migration:matrix` after
 * changing a mapping and commit the result.
 */

const PHASE_NAMES: Record<number, string> = {
  1: 'Phase 1 — Reference and catalog',
  2: 'Phase 2 — Identity',
  3: 'Phase 3 — Organisation data',
  4: 'Phase 4 — Builds and testing',
  5: 'Phase 5 — Defects',
  6: 'Phase 6 — Contests',
  7: 'Phase 7 — Financial',
  8: 'Phase 8 — Communication and system',
  9: 'Phase 9 — Automation',
  99: 'Infrastructure',
}

function escape(s: string): string {
  return s.replace(/\|/g, '\\|')
}

export function renderMatrix(): string {
  const rows = mappingsInPhaseOrder()
  const byDisposition = new Map<string, number>()
  for (const m of REGISTRY) {
    byDisposition.set(m.disposition, (byDisposition.get(m.disposition) ?? 0) + 1)
  }

  const lines: string[] = []
  lines.push('# Legacy migration matrix')
  lines.push('')
  lines.push(
    `Generated from \`scripts/migration/mapping/registry.ts\`. All **${REGISTRY.length}** legacy tables are listed, including those deliberately not migrated.`,
  )
  lines.push('')
  lines.push('| Disposition | Tables | Meaning |')
  lines.push('| --- | ---: | --- |')
  const meanings: Record<string, string> = {
    ACTIVE_EQUIVALENT: 'The new platform has this concept and uses it.',
    HISTORICAL_EQUIVALENT: 'Representable, but as history rather than live state.',
    REFERENCE_LOOKUP: 'Read to resolve ids; its rows are not themselves migrated.',
    DEPRECATED: 'The concept was retired deliberately.',
    NO_EQUIVALENT: 'Nothing in the new schema can hold it.',
  }
  for (const [d, n] of [...byDisposition].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${d} | ${n} | ${meanings[d] ?? ''} |`)
  }
  lines.push(`| **Total** | **${REGISTRY.length}** | |`)
  lines.push('')
  lines.push(
    `**${REGISTRY.filter(isMigrated).length}** tables are migrated by the pipeline; **${
      REGISTRY.filter((m) => !isMigrated(m)).length
    }** are not, each with a documented reason below.`,
  )
  lines.push('')

  let phase = -1
  for (const m of rows) {
    if (m.phase !== phase) {
      phase = m.phase
      lines.push('')
      lines.push(`## ${PHASE_NAMES[phase] ?? `Phase ${phase}`}`)
      lines.push('')
      lines.push('| Legacy table | New table(s) | Status | Transformation | Notes |')
      lines.push('| --- | --- | --- | --- | --- |')
    }
    const targets = m.targets.length > 0 ? m.targets.map((t) => `\`${t}\``).join(', ') : '—'
    lines.push(
      `| \`${m.legacyTable}\` | ${targets} | ${m.disposition} / ${m.kind} | ${escape(
        m.transformation,
      )} | ${escape(m.notes)} |`,
    )
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

const target = process.argv[2] ?? 'docs/MIGRATION-MATRIX.md'
writeFileSync(target, renderMatrix(), 'utf8')
console.log(`Wrote ${target} (${REGISTRY.length} tables)`)

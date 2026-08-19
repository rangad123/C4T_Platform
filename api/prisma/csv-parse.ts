import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads a CSV shaped like the legacy exports in `prisma/csv/`. Fields are
 * usually double-quoted, comma-separated, one row per line — but a few rows
 * (e.g. `os_versions.csv`'s trailing NULL/empty columns) have bare unquoted
 * tokens instead, so a plain `split('","')` mis-parses them. This is a small
 * state-machine parser instead: quoted fields end at the next unescaped `"`,
 * unquoted fields end at the next `,`. No `""`-escaped-quote handling — none
 * of the 9 source files contain an embedded quote, verified before writing
 * this.
 */
function parseLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1)
      const value = end === -1 ? line.slice(i + 1) : line.slice(i + 1, end)
      fields.push(value)
      i = (end === -1 ? line.length : end + 1) + 1 // skip closing quote and the comma after it
    } else {
      const end = line.indexOf(',', i)
      const value = end === -1 ? line.slice(i) : line.slice(i, end)
      fields.push(value === 'NULL' ? '' : value)
      i = (end === -1 ? line.length : end) + 1
    }
  }
  return fields
}

export function readCsv(name: string): Record<string, string>[] {
  const text = readFileSync(join(import.meta.dirname, 'csv', `${name}.csv`), 'utf-8')
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const [headerLine, ...rows] = lines
  const headers = parseLine(headerLine!)

  return rows.map((line) => {
    const cells = parseLine(line)
    const record: Record<string, string> = {}
    headers.forEach((h, i) => {
      record[h] = cells[i] ?? ''
    })
    return record
  })
}

/**
 * Reads one column, guaranteed to be a `string` (`''` if absent) — every
 * column in these exports is optional at the type level under
 * `noUncheckedIndexedAccess`, even though `readCsv` always populates every
 * header key. Centralises the `?? ''` instead of repeating it at every call
 * site.
 */
export function field(row: Record<string, string>, key: string): string {
  return row[key] ?? ''
}

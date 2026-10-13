/**
 * The last day of an Indian financial year, from the label the legacy
 * `tds_history.tds_fy` column holds.
 *
 * India's year runs 1 April to 31 March and is named for the two calendar
 * years it spans — "2018-19" is 1 Apr 2018 to 31 Mar 2019. A TDS figure for a
 * year belongs inside that year, so a row is dated on its last day: that keeps
 * it in the right bucket when the ledger is filtered by finance year.
 *
 * Returns null for anything that is not clearly a one-year span ("2019" alone
 * could be the year it starts or the year it ends), and the caller falls back
 * to the date the row was recorded rather than guessing.
 */
export function financialYearEnd(label: string | null | undefined): Date | null {
  if (!label) return null
  const match = /(\d{4})\s*[-–/]\s*(\d{2}|\d{4})(?!\d)/.exec(label)
  if (!match) return null

  const start = Number(match[1])
  const tail = match[2] ?? ''
  let end = tail.length === 2 ? Math.floor(start / 100) * 100 + Number(tail) : Number(tail)
  // 1999-00: the two-digit tail rolls the century.
  if (tail.length === 2 && end <= start) end += 100

  if (end !== start + 1) return null
  return new Date(Date.UTC(end, 2, 31))
}

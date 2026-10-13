import { describe, expect, it } from 'vitest'
import { financialYearEnd } from '../../scripts/migration/transform/fiscal.js'

const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null

describe('financialYearEnd', () => {
  it('reads the usual labels as 31 March of the later year', () => {
    expect(iso(financialYearEnd('2018-19'))).toBe('2019-03-31')
    expect(iso(financialYearEnd('2018-2019'))).toBe('2019-03-31')
    expect(iso(financialYearEnd('2018/19'))).toBe('2019-03-31')
    expect(iso(financialYearEnd('FY 2023-24'))).toBe('2024-03-31')
    expect(iso(financialYearEnd('2018 – 19'))).toBe('2019-03-31')
  })

  it('rolls the century on a two-digit tail', () => {
    expect(iso(financialYearEnd('1999-00'))).toBe('2000-03-31')
  })

  it('refuses anything that is not a one-year span, so the caller falls back to the recorded date', () => {
    expect(financialYearEnd('2019')).toBeNull()
    expect(financialYearEnd('2018-20')).toBeNull()
    expect(financialYearEnd('2019-18')).toBeNull()
    expect(financialYearEnd('last year')).toBeNull()
    expect(financialYearEnd('')).toBeNull()
    expect(financialYearEnd(null)).toBeNull()
    expect(financialYearEnd(undefined)).toBeNull()
  })

  it('does not read a longer number as a year', () => {
    expect(financialYearEnd('2018-199')).toBeNull()
  })
})

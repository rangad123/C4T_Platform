import { describe, expect, it } from 'vitest'
import {
  amountToMinor,
  bool,
  clamp,
  countryCode,
  email,
  enumValue,
  int,
  legacyRef,
  list,
  slugify,
  text,
  timestamp,
  timestampOr,
  url,
} from '../../scripts/migration/transform/values.js'

/**
 * The legacy migration's transformation layer.
 *
 * Every case here is a real shape from the legacy MariaDB schema rather than an
 * invented one — MySQL zero dates, `enum('active','inactive')`, comma-separated
 * id columns, money in `double`/`varchar`. These are the decisions that turn
 * into silent corruption if they are wrong, and they are testable without
 * either database, so they are tested.
 */

describe('text', () => {
  it('collapses the several spellings of nothing', () => {
    expect(text(null)).toBeNull()
    expect(text(undefined)).toBeNull()
    expect(text('')).toBeNull()
    expect(text('   ')).toBeNull()
    // The legacy dump uses `DEFAULT ''` where the new schema is nullable.
    expect(text('NULL')).toBeNull()
    expect(text('null')).toBeNull()
  })

  it('trims but preserves real content', () => {
    expect(text('  Acme Ltd  ')).toBe('Acme Ltd')
    expect(text(0)).toBe('0')
  })
})

describe('timestamp', () => {
  it('maps the MySQL zero date to null rather than Invalid Date', () => {
    expect(timestamp('0000-00-00 00:00:00')).toBeNull()
    expect(timestamp('0000-00-00')).toBeNull()
  })

  it('reads a legacy timestamp as UTC, not local time', () => {
    // The dump sets time_zone = "+00:00". Reading this in +05:30 without
    // forcing UTC would shift it by five and a half hours.
    const parsed = timestamp('2019-04-02 11:15:00')
    expect(parsed?.toISOString()).toBe('2019-04-02T11:15:00.000Z')
  })

  it('does not re-zone a value that already carries an offset', () => {
    expect(timestamp('2019-04-02T11:15:00Z')?.toISOString()).toBe('2019-04-02T11:15:00.000Z')
  })

  it('rejects junk', () => {
    expect(timestamp('not a date')).toBeNull()
    expect(timestamp('')).toBeNull()
  })

  it('falls back in order, and never silently to now()', () => {
    const fallback = new Date('2020-01-01T00:00:00Z')
    expect(timestampOr('0000-00-00 00:00:00', fallback).toISOString()).toBe(
      '2020-01-01T00:00:00.000Z',
    )
    expect(timestampOr('2019-04-02 11:15:00', fallback).toISOString()).toBe(
      '2019-04-02T11:15:00.000Z',
    )
  })
})

describe('bool', () => {
  it('understands every spelling the legacy schema uses', () => {
    // tinyint(1)
    expect(bool(1)).toBe(true)
    expect(bool(0)).toBe(false)
    // enum('yes','no')
    expect(bool('yes')).toBe(true)
    expect(bool('no')).toBe(false)
    // enum('active','inactive')
    expect(bool('active')).toBe(true)
    expect(bool('inactive')).toBe(false)
    // enum('verified','rejected')
    expect(bool('verified')).toBe(true)
    expect(bool('rejected')).toBe(false)
  })

  it('uses the fallback for anything it does not recognise', () => {
    expect(bool('maybe', true)).toBe(true)
    expect(bool(null, false)).toBe(false)
  })
})

describe('legacyRef', () => {
  it('treats 0 as absent, because the legacy schema uses it as "unset"', () => {
    // project_os_id, project_test_type_id and project_pricing_model_id all
    // DEFAULT 0. Reading that as an id points every project at row 1.
    expect(legacyRef(0)).toBeNull()
    expect(legacyRef('0')).toBeNull()
  })

  it('keeps a real id as a string', () => {
    expect(legacyRef(42)).toBe('42')
    expect(legacyRef('42')).toBe('42')
  })
})

describe('list', () => {
  it('splits the comma-separated id columns', () => {
    expect(list('1,2,3')).toEqual(['1', '2', '3'])
    expect(list('1, 2 , 3')).toEqual(['1', '2', '3'])
  })

  it('handles the other separators seen in dumps of this era', () => {
    expect(list('a;b|c')).toEqual(['a', 'b', 'c'])
  })

  it('deduplicates, because legacy multi-selects double up', () => {
    expect(list('2,2,3')).toEqual(['2', '3'])
  })

  it('reads a JSON array where a later PHP version wrote one', () => {
    expect(list('["4","5"]')).toEqual(['4', '5'])
  })

  it('is empty for nothing', () => {
    expect(list(null)).toEqual([])
    expect(list('')).toEqual([])
    expect(list(',,')).toEqual([])
  })
})

describe('amountToMinor', () => {
  it('converts money to integer minor units', () => {
    expect(amountToMinor(2500)).toBe(2500_00n)
    expect(amountToMinor('2500.50')).toBe(250050n)
  })

  it('strips currency symbols and thousands separators', () => {
    expect(amountToMinor('₹1,250.75')).toBe(125075n)
    expect(amountToMinor('$99.99')).toBe(9999n)
  })

  it('rounds once rather than letting float error accumulate', () => {
    expect(amountToMinor(0.1 + 0.2)).toBe(30n)
  })

  it('handles negatives, which adjustments use', () => {
    expect(amountToMinor('-150.00')).toBe(-15000n)
  })

  it('returns null for junk instead of 0', () => {
    // 0 would be a real amount; null is "we could not read this".
    expect(amountToMinor('n/a')).toBeNull()
    expect(amountToMinor(null)).toBeNull()
  })
})

describe('email', () => {
  it('lowercases and accepts a valid address', () => {
    expect(email('  Tester@Example.COM ')).toEqual({ value: 'tester@example.com', problem: null })
  })

  it('reports rather than silently dropping a malformed address', () => {
    const result = email('not-an-email')
    expect(result.value).toBeNull()
    expect(result.problem?.problem).toMatch(/malformed/)
  })

  it('reports a missing address', () => {
    expect(email(null).problem?.problem).toBe('missing')
  })
})

describe('countryCode', () => {
  const isValid = (c: string) => ['IN', 'US', 'GB'].includes(c)
  const byName = (n: string) =>
    ({ india: 'IN', 'united states': 'US' })[n.trim().toLowerCase()] ?? null

  it('passes a valid alpha-2 through', () => {
    expect(countryCode('in', isValid, byName).value).toBe('IN')
  })

  it('resolves a country name, since usr_country is varchar(50)', () => {
    expect(countryCode('India', isValid, byName).value).toBe('IN')
  })

  it('reports an unrecognised value rather than guessing', () => {
    const result = countryCode('Freedonia', isValid, byName)
    expect(result.value).toBeNull()
    expect(result.problem?.problem).toMatch(/unrecognised/)
  })

  it('treats absent as absent, not as a problem', () => {
    expect(countryCode(null, isValid, byName)).toEqual({ value: null, problem: null })
  })
})

describe('enumValue', () => {
  const table = { in_progress: 'IN_PROGRESS', done: 'DONE' } as const

  it('normalises case, spaces and hyphens onto one key', () => {
    for (const spelling of ['In Progress', 'in-progress', 'IN_PROGRESS', 'in progress']) {
      expect(enumValue(spelling, table, 'DONE', 'status').value).toBe('IN_PROGRESS')
    }
  })

  it('defaults AND reports when the value is unmapped', () => {
    const result = enumValue('exploded', table, 'DONE', 'status')
    expect(result.value).toBe('DONE')
    expect(result.problem?.problem).toMatch(/unmapped/)
  })

  it('does not report a missing value — absent is not invalid', () => {
    expect(enumValue(null, table, 'DONE', 'status')).toEqual({ value: 'DONE', problem: null })
  })
})

describe('clamp', () => {
  it('reports a truncation instead of silently cutting', () => {
    const result = clamp('x'.repeat(300), 120, 'title')
    expect(result.value).toHaveLength(120)
    expect(result.problem?.problem).toMatch(/exceeds destination limit/)
  })

  it('leaves a value that fits alone', () => {
    expect(clamp('short', 120, 'title')).toEqual({ value: 'short', problem: null })
  })
})

describe('url', () => {
  it('adds a scheme to a bare host, which legacy profile links omit', () => {
    expect(url('linkedin.com/in/someone', 'linkedinUrl').value).toBe(
      'https://linkedin.com/in/someone',
    )
  })

  it('reports a malformed URL', () => {
    expect(url('http://', 'linkedinUrl').problem?.problem).toMatch(/malformed/)
  })
})

describe('int / slugify', () => {
  it('parses integers and rejects junk', () => {
    expect(int('7')).toBe(7)
    expect(int('')).toBeNull()
    expect(int('abc')).toBeNull()
  })

  it('slugifies for the unique slug columns', () => {
    expect(slugify('  Northwind Fintech!  ')).toBe('northwind-fintech')
  })
})

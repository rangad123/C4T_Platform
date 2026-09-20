import { describe, expect, it } from 'vitest'
import {
  buildTdsSchedule,
  employedMonths,
  monthlyTdsAmount,
} from '../../src/lib/hrms/hr-tds-schedule.js'

const FY = '2026-2027'
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const FULL_YEAR = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]

describe('employedMonths', () => {
  it('is the whole year for someone who was there before it began and has not left', () => {
    expect(employedMonths(FY, { joiningDate: d('2020-01-01'), relievingDate: null })).toEqual(
      FULL_YEAR,
    )
  })

  it('starts in the joining month, even when they joined part-way through it', () => {
    // A payslip is a whole-month document: someone who joined on the 20th of
    // August still has an August payslip and must have tax taken from it.
    expect(employedMonths(FY, { joiningDate: d('2026-08-20'), relievingDate: null })).toEqual([
      8, 9, 10, 11, 12, 1, 2, 3,
    ])
  })

  it('ends in the relieving month', () => {
    expect(
      employedMonths(FY, { joiningDate: d('2020-01-01'), relievingDate: d('2026-12-05') }),
    ).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('treats a relieving date in the future — a notice period — as still employed', () => {
    expect(
      employedMonths(FY, { joiningDate: d('2020-01-01'), relievingDate: d('2027-03-31') }),
    ).toEqual(FULL_YEAR)
  })

  it('is empty for someone who joins after the year has ended', () => {
    expect(employedMonths(FY, { joiningDate: d('2027-04-01'), relievingDate: null })).toEqual([])
  })

  it('is empty for someone who left before the year began', () => {
    expect(
      employedMonths(FY, { joiningDate: d('2020-01-01'), relievingDate: d('2026-03-31') }),
    ).toEqual([])
  })
})

describe('monthlyTdsAmount', () => {
  it('spreads what is owed over the months left', () => {
    expect(
      monthlyTdsAmount({ annualLiability: 120000, deductedSoFar: 0, monthsRemaining: 12 }),
    ).toBe(10000)
  })

  it('collects everything still owed in the last month', () => {
    expect(
      monthlyTdsAmount({ annualLiability: 120000, deductedSoFar: 110000, monthsRemaining: 1 }),
    ).toBe(10000)
  })

  it('rounds to whole rupees', () => {
    expect(
      monthlyTdsAmount({ annualLiability: 100000, deductedSoFar: 0, monthsRemaining: 12 }),
    ).toBe(8333)
  })

  it('never goes negative when more has been deducted than the year now comes to', () => {
    expect(
      monthlyTdsAmount({ annualLiability: 50000, deductedSoFar: 60000, monthsRemaining: 4 }),
    ).toBe(0)
  })

  it('takes nothing when there are no months left', () => {
    expect(monthlyTdsAmount({ annualLiability: 50000, deductedSoFar: 0, monthsRemaining: 0 })).toBe(
      0,
    )
  })

  it('takes nothing when there is no tax', () => {
    expect(monthlyTdsAmount({ annualLiability: 0, deductedSoFar: 0, monthsRemaining: 12 })).toBe(0)
  })
})

describe('buildTdsSchedule', () => {
  const employed = { joiningDate: d('2020-01-01'), relievingDate: null }

  it('collects exactly the annual tax across the year, whatever the rounding', () => {
    // 100,000 / 12 is not a whole number, so each month is rounded — but each
    // month is recomputed from what was actually deducted, so the total lands
    // on the annual figure to the rupee rather than drifting by a few.
    const schedule = buildTdsSchedule({
      financialYear: FY,
      window: employed,
      annualLiability: 100000,
      recorded: new Map(),
      throughMonth: 3,
    })

    expect(schedule.map((s) => s.month)).toEqual(FULL_YEAR)
    expect(schedule.reduce((sum, s) => sum + s.amount, 0)).toBe(100000)
  })

  it('never changes a month that already has an amount, and counts it as deducted', () => {
    const schedule = buildTdsSchedule({
      financialYear: FY,
      window: employed,
      annualLiability: 120000,
      recorded: new Map([[4, 20000]]),
      throughMonth: 6,
    })

    // April keeps its 20,000 and is not in the output. May and June share the
    // remaining 100,000 over the eleven and ten months left.
    expect(schedule).toEqual([
      { month: 5, amount: 9091 },
      { month: 6, amount: 9091 },
    ])
  })

  it('fills only up to the month asked for', () => {
    const schedule = buildTdsSchedule({
      financialYear: FY,
      window: employed,
      annualLiability: 120000,
      recorded: new Map(),
      throughMonth: 6,
    })
    expect(schedule.map((s) => s.month)).toEqual([4, 5, 6])
  })

  it('gives the same figure for a month regardless of how far the run goes', () => {
    // The answer for June must not depend on whether someone asked for June
    // or for December — otherwise generating payslips in a different order
    // would put different tax on the same payslip.
    const args = {
      financialYear: FY,
      window: employed,
      annualLiability: 137000,
      recorded: new Map<number, number>(),
    }
    const toJune = buildTdsSchedule({ ...args, throughMonth: 6 })
    const toDecember = buildTdsSchedule({ ...args, throughMonth: 12 })

    expect(toDecember.slice(0, toJune.length)).toEqual(toJune)
  })

  it('spreads a part-year over the months actually employed', () => {
    // Joined in August: eight months to collect 80,000, not twelve.
    const schedule = buildTdsSchedule({
      financialYear: FY,
      window: { joiningDate: d('2026-08-20'), relievingDate: null },
      annualLiability: 80000,
      recorded: new Map(),
      throughMonth: 8,
    })
    expect(schedule).toEqual([{ month: 8, amount: 10000 }])
  })

  it('produces nothing for a month before they joined', () => {
    const schedule = buildTdsSchedule({
      financialYear: FY,
      window: { joiningDate: d('2026-08-20'), relievingDate: null },
      annualLiability: 80000,
      recorded: new Map(),
      throughMonth: 6,
    })
    expect(schedule).toEqual([])
  })

  it('produces nothing when there is no tax', () => {
    const schedule = buildTdsSchedule({
      financialYear: FY,
      window: employed,
      annualLiability: 0,
      recorded: new Map(),
      throughMonth: 3,
    })
    expect(schedule.every((s) => s.amount === 0)).toBe(true)
  })

  it('ignores a month that is not in the financial year', () => {
    expect(
      buildTdsSchedule({
        financialYear: FY,
        window: employed,
        annualLiability: 100000,
        recorded: new Map(),
        throughMonth: 13,
      }),
    ).toEqual([])
  })
})

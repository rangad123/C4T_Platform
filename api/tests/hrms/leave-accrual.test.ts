import { describe, expect, it } from 'vitest'
import { accruesMonthly, creditsEarned, daysEarned } from '../../src/lib/hrms/hr-leave-accrual.js'

const FY = '2026-2027'
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const whole = { joiningDate: d('2020-01-01'), relievingDate: null }

describe('creditsEarned', () => {
  it('gives someone who joined in August their first credit on 1 September', () => {
    const joiner = { joiningDate: d('2026-08-20'), relievingDate: null }
    // Not there on 1 August, so nothing for August; then September's.
    expect(creditsEarned(FY, d('2026-08-31'), joiner)).toBe(0)
    expect(creditsEarned(FY, d('2026-09-01'), joiner)).toBe(1)
    expect(creditsEarned(FY, d('2026-09-30'), joiner)).toBe(1)
    expect(creditsEarned(FY, d('2026-10-01'), joiner)).toBe(2)
  })

  it('counts someone who joins on the 1st for that month', () => {
    expect(
      creditsEarned(FY, d('2026-08-15'), { joiningDate: d('2026-08-01'), relievingDate: null }),
    ).toBe(1)
  })

  it('gives someone employed all year one credit on 1 April, six by 1 September and twelve by 1 March', () => {
    expect(creditsEarned(FY, d('2026-04-01'), whole)).toBe(1)
    expect(creditsEarned(FY, d('2026-09-01'), whole)).toBe(6)
    expect(creditsEarned(FY, d('2027-03-01'), whole)).toBe(12)
    expect(creditsEarned(FY, d('2027-03-31'), whole)).toBe(12)
  })

  it('has earned nothing in a year that has not started', () => {
    expect(creditsEarned(FY, d('2026-03-31'), whole)).toBe(0)
  })

  it('counts every month they were there for in a year that has ended', () => {
    expect(creditsEarned(FY, d('2030-01-01'), whole)).toBe(12)
    expect(
      creditsEarned(FY, d('2030-01-01'), { joiningDate: d('2026-10-10'), relievingDate: null }),
    ).toBe(5)
  })

  it('stops earning after they have left', () => {
    const leaver = { joiningDate: d('2020-01-01'), relievingDate: d('2026-08-15') }
    // Employed on 1 April..1 August, gone by 1 September.
    expect(creditsEarned(FY, d('2027-03-31'), leaver)).toBe(5)
  })

  it('still credits the month they leave in if they were there on the 1st', () => {
    expect(
      creditsEarned(FY, d('2026-09-30'), {
        joiningDate: d('2020-01-01'),
        relievingDate: d('2026-09-01'),
      }),
    ).toBe(6)
  })

  it('earns nothing for someone who left before the year began', () => {
    expect(
      creditsEarned(FY, d('2027-03-31'), {
        joiningDate: d('2020-01-01'),
        relievingDate: d('2026-03-31'),
      }),
    ).toBe(0)
  })
})

describe('daysEarned', () => {
  it('is one day a credit for twelve days a year', () => {
    expect(daysEarned(12, 1)).toBe(1)
    expect(daysEarned(12, 2)).toBe(2)
    expect(daysEarned(12, 12)).toBe(12)
  })

  it('spreads other yearly totals evenly and rounds to two places', () => {
    expect(daysEarned(15, 4)).toBe(5)
    expect(daysEarned(10, 1)).toBe(0.83)
  })

  it('is nothing with no credits or no entitlement', () => {
    expect(daysEarned(12, 0)).toBe(0)
    expect(daysEarned(0, 6)).toBe(0)
  })
})

describe('accruesMonthly', () => {
  it('is casual leave and privilege leave, which is also called earned leave', () => {
    for (const name of ['Casual leave', 'Privilege Leave', 'Earned leave', ' casual LEAVE ']) {
      expect(accruesMonthly(name), name).toBe(true)
    }
  })

  it('leaves every other type on its full days for the year', () => {
    for (const name of [
      'Maternity leave',
      'Paternity leave',
      'Sick leave',
      'Unpaid leave',
      'Casual leave extra',
    ]) {
      expect(accruesMonthly(name), name).toBe(false)
    }
  })
})

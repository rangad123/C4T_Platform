import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFESSIONAL_TAX_MONTHLY,
  PROFESSIONAL_TAX_THRESHOLD_MONTHLY,
  professionalTaxDeducted,
  professionalTaxFor,
} from '../../src/lib/hrms/hr-professional-tax.js'

describe('professionalTaxFor', () => {
  it('is Rs. 200 on a monthly gross above Rs. 25,000', () => {
    expect(professionalTaxFor({ grossMonthly: 60000, configuredMonthly: null })).toBe(200)
    expect(professionalTaxFor({ grossMonthly: 25000.01, configuredMonthly: null })).toBe(200)
  })

  it('is nothing at or below the threshold', () => {
    // "More than 25,000": someone on exactly 25,000 pays none.
    expect(
      professionalTaxFor({
        grossMonthly: PROFESSIONAL_TAX_THRESHOLD_MONTHLY,
        configuredMonthly: null,
      }),
    ).toBe(0)
    expect(professionalTaxFor({ grossMonthly: 24999, configuredMonthly: null })).toBe(0)
    expect(professionalTaxFor({ grossMonthly: 0, configuredMonthly: null })).toBe(0)
  })

  it('uses the year’s configured amount when there is one', () => {
    expect(professionalTaxFor({ grossMonthly: 60000, configuredMonthly: 300 })).toBe(300)
  })

  it('treats a configured amount of 0 as "no professional tax this year"', () => {
    expect(professionalTaxFor({ grossMonthly: 60000, configuredMonthly: 0 })).toBe(0)
  })

  it('never charges below the threshold, whatever is configured', () => {
    expect(professionalTaxFor({ grossMonthly: 20000, configuredMonthly: 300 })).toBe(0)
  })

  it('does not treat a missing gross as high earnings', () => {
    expect(professionalTaxFor({ grossMonthly: Number.NaN, configuredMonthly: null })).toBe(0)
  })

  it('defaults to the amount the business asked for', () => {
    expect(DEFAULT_PROFESSIONAL_TAX_MONTHLY).toBe(200)
  })
})

describe('professionalTaxDeducted', () => {
  it('reads what a stored payslip deducted', () => {
    expect(professionalTaxDeducted({ deductions: { professionalTaxMonthly: 200 } })).toBe(200)
  })

  it('is nothing for a payslip that took none', () => {
    expect(professionalTaxDeducted({ deductions: { professionalTaxMonthly: 0 } })).toBe(0)
    expect(professionalTaxDeducted({ deductions: { tdsMonthly: 500 } })).toBe(0)
  })

  it('is nothing for a snapshot that is not shaped like a payslip', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      5,
      [],
      {},
      { deductions: null },
      { deductions: { professionalTaxMonthly: '200' } },
    ]) {
      expect(professionalTaxDeducted(bad)).toBe(0)
    }
  })

  it('ignores a negative or non-finite amount', () => {
    expect(professionalTaxDeducted({ deductions: { professionalTaxMonthly: -200 } })).toBe(0)
    expect(professionalTaxDeducted({ deductions: { professionalTaxMonthly: Number.NaN } })).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { payslipRunState } from '../../src/lib/hrms/hr-payslip-run.js'

const ok = { hasPayslip: false, employed: true, hasBreakdown: true }

describe('payslipRunState', () => {
  it('is ready when they were employed, have a breakdown and have no payslip yet', () => {
    expect(payslipRunState(ok)).toBe('ready')
  })

  it('leaves an existing payslip alone, whatever else is true', () => {
    expect(payslipRunState({ ...ok, hasPayslip: true })).toBe('generated')
    expect(payslipRunState({ hasPayslip: true, employed: false, hasBreakdown: false })).toBe(
      'generated',
    )
  })

  it('reports a missing breakdown rather than generating a payslip of zeros', () => {
    expect(payslipRunState({ ...ok, hasBreakdown: false })).toBe('no-salary-breakdown')
  })

  it('does not ask for a breakdown from someone who was not employed that month', () => {
    expect(payslipRunState({ ...ok, employed: false })).toBe('not-employed')
    expect(payslipRunState({ ...ok, employed: false, hasBreakdown: false })).toBe('not-employed')
  })
})

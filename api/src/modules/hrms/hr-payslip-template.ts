/**
 * Pure HTML rendering for a payslip — no I/O, takes the already-assembled
 * snapshot and returns a print-ready HTML string for hr-pdf.ts to rasterize.
 * Kept separate from hr-payslip.service.ts so the template can be read (and
 * changed) without wading through the data-assembly logic around it.
 */

import { logoImg } from '../../lib/hrms/hr-logo.js'

export interface PayslipIncentiveLine {
  type: string
  amount: number
}

export interface PayslipSnapshot {
  employee: {
    employeeCode: string
    firstName: string
    lastName: string
    designation: string | null
    email: string
    panMasked: string | null
    bankName: string | null
    accountNumberMasked: string | null
  }
  financialYear: string
  month: number
  monthLabel: string
  earnings: {
    basicMonthly: number
    hraMonthly: number
    specialAllowanceMonthly: number
    incentives: PayslipIncentiveLine[]
    grossMonthly: number
  }
  deductions: {
    tdsMonthly: number
    /** Flat monthly professional tax. Absent on payslips imported from the
     *  old HR system before this was modelled. */
    professionalTaxMonthly?: number
    totalDeductions: number
  }
  netPay: number
  generatedAt: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function money(value: number): string {
  return `Rs. ${Math.round(value).toLocaleString('en-IN')}`
}

function row(label: string, value: string): string {
  return `<tr><td class="label">${escapeHtml(label)}</td><td class="value">${escapeHtml(value)}</td></tr>`
}

export function renderPayslipHtml(snapshot: PayslipSnapshot): string {
  const { employee, earnings, deductions } = snapshot

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #241e18; margin: 0; padding: 0; font-size: 12px; }
  .sheet { padding: 8px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .brand { margin: 0 0 10px; }
  .brand img { display: block; }
  .subtitle { color: #625950; margin: 0 0 20px; }
  .meta { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  .meta td { padding: 3px 0; }
  .meta .label { color: #625950; width: 160px; }
  .meta .value { font-weight: 600; }
  .columns { display: flex; gap: 24px; }
  .column { flex: 1; }
  table.lines { width: 100%; border-collapse: collapse; }
  table.lines th { text-align: left; border-bottom: 1px solid #c9c3bc; padding: 6px 0; color: #625950; font-weight: 600; }
  table.lines td { padding: 6px 0; border-bottom: 1px solid #e4dfd9; }
  table.lines td.amount { text-align: right; font-variant-numeric: tabular-nums; }
  .total-row td { font-weight: 700; border-top: 2px solid #241e18; border-bottom: none; }
  .net-pay { margin-top: 24px; padding: 14px; background: #f1ede8; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
  .net-pay .label { font-size: 14px; font-weight: 700; }
  .net-pay .amount { font-size: 20px; font-weight: 700; }
  .footer { margin-top: 24px; color: #9a928b; font-size: 10px; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="brand">${logoImg(150)}</div>
    <p class="subtitle">Payslip for ${escapeHtml(snapshot.monthLabel)}</p>

    <table class="meta">
      ${row('Employee name', `${employee.firstName} ${employee.lastName}`)}
      ${row('Employee code', employee.employeeCode)}
      ${row('Designation', employee.designation ?? '—')}
      ${row('Financial year', snapshot.financialYear)}
      ${employee.panMasked ? row('PAN', employee.panMasked) : ''}
      ${employee.bankName ? row('Bank', `${employee.bankName}${employee.accountNumberMasked ? ` (${employee.accountNumberMasked})` : ''}`) : ''}
    </table>

    <div class="columns">
      <div class="column">
        <table class="lines">
          <thead><tr><th colspan="2">Earnings</th></tr></thead>
          <tbody>
            <tr><td>Basic</td><td class="amount">${money(earnings.basicMonthly)}</td></tr>
            <tr><td>HRA</td><td class="amount">${money(earnings.hraMonthly)}</td></tr>
            <tr><td>Special allowance</td><td class="amount">${money(earnings.specialAllowanceMonthly)}</td></tr>
            ${earnings.incentives.map((line) => `<tr><td>${escapeHtml(line.type)}</td><td class="amount">${money(line.amount)}</td></tr>`).join('')}
            <tr class="total-row"><td>Gross earnings</td><td class="amount">${money(earnings.grossMonthly)}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="column">
        <table class="lines">
          <thead><tr><th colspan="2">Deductions</th></tr></thead>
          <tbody>
            <tr><td>TDS</td><td class="amount">${money(deductions.tdsMonthly)}</td></tr>
            ${
              deductions.professionalTaxMonthly
                ? `<tr><td>Professional tax</td><td class="amount">${money(deductions.professionalTaxMonthly)}</td></tr>`
                : ''
            }
            <tr class="total-row"><td>Total deductions</td><td class="amount">${money(deductions.totalDeductions)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="net-pay">
      <span class="label">Net pay</span>
      <span class="amount">${money(snapshot.netPay)}</span>
    </div>

    <p class="footer">Generated ${escapeHtml(new Date(snapshot.generatedAt).toLocaleString('en-IN'))}. This is a system-generated document.</p>
  </div>
</body>
</html>`
}

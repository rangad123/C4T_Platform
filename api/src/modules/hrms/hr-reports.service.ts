import { HrEmployeeStatus, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { renderHtmlToPdf } from '../../lib/hrms/hr-pdf.js'
import { financialYearMonths } from '../../lib/hrms/financial-year.js'
import { getMonthSummary } from './hr-timesheet.service.js'
import type { GenerateReportQuery } from './hr-reports.schema.js'

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber()
}

/** Indian FY quarters: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar. */
const QUARTER_MONTHS: Record<number, number[]> = {
  1: [4, 5, 6],
  2: [7, 8, 9],
  3: [10, 11, 12],
  4: [1, 2, 3],
}

function resolveMonths(query: GenerateReportQuery): number[] {
  if (query.period === 'MONTHLY') return [query.month!]
  if (query.period === 'QUARTERLY') return QUARTER_MONTHS[query.quarter!] ?? []
  return [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]
}

function periodLabel(query: GenerateReportQuery): string {
  if (query.period === 'MONTHLY') {
    return (
      financialYearMonths(query.financialYear).find((m) => m.month === query.month)?.label ?? ''
    )
  }
  if (query.period === 'QUARTERLY') return `Q${query.quarter}`
  return 'Full year'
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function money(value: number): string {
  return `Rs. ${Math.round(value).toLocaleString('en-IN')}`
}

function reportShell(title: string, subtitle: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #241e18; margin: 0; padding: 16px; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .subtitle { color: #625950; margin: 0 0 20px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; border-bottom: 1px solid #c9c3bc; padding: 6px 8px; color: #625950; }
  td { padding: 6px 8px; border-bottom: 1px solid #e4dfd9; }
  td.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; }
  .total-row td { font-weight: 700; border-top: 2px solid #241e18; border-bottom: none; }
  .empty { padding: 40px 0; text-align: center; color: #9a928b; }
</style>
</head>
<body>
  <h1>Crowd4Test — ${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(subtitle)}</p>
  ${body}
</body>
</html>`
}

async function generateTdsReport(query: GenerateReportQuery): Promise<string> {
  const months = resolveMonths(query)
  const rows = await prisma.hrMonthlyTaxDeduction.groupBy({
    by: ['employeeId'],
    where: { financialYear: query.financialYear, month: { in: months } },
    _sum: { amount: true },
  })

  if (rows.length === 0) {
    return reportShell(
      'TDS report',
      `${query.financialYear} — ${periodLabel(query)}`,
      '<p class="empty">No TDS deductions recorded for this period.</p>',
    )
  }

  const employees = await prisma.hrEmployee.findMany({
    where: { id: { in: rows.map((r) => r.employeeId) } },
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  })
  const byId = new Map(employees.map((e) => [e.id, e]))

  let total = 0
  const lines = rows
    .map((r) => {
      const amount = r._sum.amount ? toNumber(r._sum.amount) : 0
      total += amount
      const employee = byId.get(r.employeeId)
      return { employee, amount }
    })
    .filter((line) => line.employee)
    .sort((a, b) => (a.employee!.employeeCode < b.employee!.employeeCode ? -1 : 1))

  const body = `
    <table>
      <thead><tr><th>Employee code</th><th>Name</th><th class="amount">TDS deducted</th></tr></thead>
      <tbody>
        ${lines
          .map(
            (line) =>
              `<tr><td>${escapeHtml(line.employee!.employeeCode)}</td><td>${escapeHtml(`${line.employee!.firstName} ${line.employee!.lastName}`)}</td><td class="amount">${money(line.amount)}</td></tr>`,
          )
          .join('')}
        <tr class="total-row"><td colspan="2">Total</td><td class="amount">${money(total)}</td></tr>
      </tbody>
    </table>`

  return reportShell('TDS report', `${query.financialYear} — ${periodLabel(query)}`, body)
}

async function generateTimesheetReport(query: GenerateReportQuery): Promise<string> {
  const months = resolveMonths(query)
  const employees = await prisma.hrEmployee.findMany({
    where: { status: HrEmployeeStatus.ACTIVE, timesheetRequired: true },
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
    orderBy: { employeeCode: 'asc' },
  })

  if (employees.length === 0) {
    return reportShell(
      'Timesheet report',
      `${query.financialYear} — ${periodLabel(query)}`,
      '<p class="empty">No employees require timesheet tracking.</p>',
    )
  }

  const rows = await Promise.all(
    employees.map(async (employee) => {
      const summaries = await Promise.all(
        months.map((month) => getMonthSummary(employee.id, query.financialYear, month)),
      )
      return {
        employee,
        workingDays: summaries.reduce((sum, s) => sum + s.workingDays, 0),
        paidDays: summaries.reduce((sum, s) => sum + s.paidDays, 0),
        loggedHours: summaries.reduce((sum, s) => sum + s.loggedHours, 0),
      }
    }),
  )

  const body = `
    <table>
      <thead><tr><th>Employee code</th><th>Name</th><th class="amount">Working days</th><th class="amount">Paid days</th><th class="amount">Logged hours</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.employee.employeeCode)}</td><td>${escapeHtml(`${row.employee.firstName} ${row.employee.lastName}`)}</td><td class="amount">${row.workingDays}</td><td class="amount">${row.paidDays}</td><td class="amount">${row.loggedHours}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>`

  return reportShell('Timesheet report', `${query.financialYear} — ${periodLabel(query)}`, body)
}

function unavailableReport(title: string, query: GenerateReportQuery, reason: string): string {
  return reportShell(
    title,
    `${query.financialYear} — ${periodLabel(query)}`,
    `<p class="empty">${escapeHtml(reason)}</p>`,
  )
}

export async function generateReport(query: GenerateReportQuery): Promise<Buffer> {
  let html: string
  if (query.reportType === 'TDS') {
    html = await generateTdsReport(query)
  } else if (query.reportType === 'TIMESHEET') {
    html = await generateTimesheetReport(query)
  } else {
    html = unavailableReport(
      'Professional tax report',
      query,
      'Professional tax is not yet tracked in this system.',
    )
  }
  return renderHtmlToPdf(html)
}

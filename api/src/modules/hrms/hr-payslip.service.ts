import { HrEmployeeStatus, HrFileScope, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, BadRequestError } from '../../lib/errors.js'
import { putObject, buildStorageKey, createDownloadUrl, deleteObject } from '../../lib/storage.js'
import { renderHtmlToPdf } from '../../lib/hrms/hr-pdf.js'
import {
  decryptHrFinancialDetails,
  maskPan,
  maskAccountNumber,
} from '../../lib/hrms/hr-encryption.js'
import { financialYearMonths } from '../../lib/hrms/financial-year.js'
import { employedMonths } from '../../lib/hrms/hr-tds-schedule.js'
import { payslipRunState } from '../../lib/hrms/hr-payslip-run.js'
import { professionalTaxFor } from '../../lib/hrms/hr-professional-tax.js'
import { renderPayslipHtml, type PayslipSnapshot } from './hr-payslip-template.js'
import { calculateMonthlyTds } from './hr-tax.service.js'

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber()
}

async function assembleSnapshot(
  employeeId: string,
  financialYear: string,
  month: number,
): Promise<PayslipSnapshot> {
  const employee = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: {
      employeeCode: true,
      firstName: true,
      lastName: true,
      email: true,
      designation: { select: { name: true } },
      bankName: true,
      secureFinancialDetails: true,
      joiningDate: true,
      relievingDate: true,
    },
  })
  if (!employee) throw new NotFoundError('Employee')

  /**
   * Refuse a month the person was not on the payroll for — before they
   * joined, or after they left.
   *
   * Found live: an admin generated an April payslip for someone who joined in
   * September, and it rendered a full month's pay because nothing checked the
   * date. The bulk payslip run already skips these months (`payslipRunState`
   * marks them `not-employed`), but this single-employee path had no such
   * check, so it was still reachable — from this route directly, and from
   * whatever calls it next.
   */
  if (!employedMonths(financialYear, employee).includes(month)) {
    const monthLabel =
      financialYearMonths(financialYear).find((m) => m.month === month)?.label ?? `Month ${month}`
    throw new BadRequestError(
      `${employee.firstName} ${employee.lastName} was not on the payroll in ${monthLabel}.`,
    )
  }

  const [salaryStructure, incentives, professionalTax] = await Promise.all([
    prisma.hrSalaryStructure.findUnique({
      where: { employeeId_financialYear: { employeeId, financialYear } },
      select: { basic: true, hra: true, specialAllowance: true },
    }),
    prisma.hrMonthlyIncentive.findMany({
      where: { employeeId, financialYear, month },
      select: { amount: true, incentiveType: { select: { name: true } } },
    }),
    prisma.hrProfessionalTaxRate.findUnique({
      where: { financialYear },
      select: { monthlyAmount: true },
    }),
  ])

  const plain = employee.secureFinancialDetails
    ? decryptHrFinancialDetails(Buffer.from(employee.secureFinancialDetails), employeeId)
    : {}

  /**
   * Refuse rather than render a payslip of zeros.
   *
   * A salary structure can exist with only a CTC and no breakdown — 19 of the
   * 45 carried over from the old system are exactly that, because the figures
   * there were derived from an employee's last payslip and those employees had
   * none. Generating anyway produced a clean, official-looking document
   * stating the person earned nothing, which is worse than an error: an error
   * gets fixed, a wrong payslip gets filed.
   *
   * The components are not guessable. A conventional basic/HRA split would be
   * an invented number on a payroll document, so this asks for the real one.
   */
  if (
    !salaryStructure ||
    toNumber(salaryStructure.basic) +
      toNumber(salaryStructure.hra) +
      toNumber(salaryStructure.specialAllowance) ===
      0
  ) {
    throw new BadRequestError(
      `No salary breakdown is recorded for ${financialYear}. Set basic, HRA and special allowance on the Salary details tab before generating a payslip.`,
    )
  }

  /**
   * This month's TDS, worked out if nobody has recorded one.
   *
   * After the breakdown guard above on purpose: a payslip that is about to be
   * refused must not leave tax rows behind for someone with no salary. And
   * before the read below, so the figure printed is the one now in the TDS
   * table — the payslip and the table cannot disagree, because the payslip is
   * reading the table.
   *
   * Lenient: a year with no tax configuration must not stop a payslip. It just
   * has no calculated TDS, and shows whatever is recorded, which is what it did
   * before this existed.
   */
  await calculateMonthlyTds(employeeId, financialYear, month, { lenient: true })
  const deduction = await prisma.hrMonthlyTaxDeduction.findUnique({
    where: { employeeId_financialYear_month: { employeeId, financialYear, month } },
    select: { amount: true },
  })

  const basicMonthly = salaryStructure ? toNumber(salaryStructure.basic) / 12 : 0
  const hraMonthly = salaryStructure ? toNumber(salaryStructure.hra) / 12 : 0
  const specialAllowanceMonthly = salaryStructure
    ? toNumber(salaryStructure.specialAllowance) / 12
    : 0
  const incentiveLines = incentives.map((row) => ({
    type: row.incentiveType.name,
    amount: toNumber(row.amount),
  }))
  const incentiveTotal = incentiveLines.reduce((sum, line) => sum + line.amount, 0)
  const grossMonthly = basicMonthly + hraMonthly + specialAllowanceMonthly + incentiveTotal

  const tdsMonthly = deduction ? toNumber(deduction.amount) : 0
  const professionalTaxMonthly = professionalTaxFor({
    grossMonthly,
    configuredMonthly: professionalTax ? toNumber(professionalTax.monthlyAmount) : null,
  })
  const totalDeductions = tdsMonthly + professionalTaxMonthly
  const monthLabel =
    financialYearMonths(financialYear).find((m) => m.month === month)?.label ?? `Month ${month}`

  return {
    employee: {
      employeeCode: employee.employeeCode,
      firstName: employee.firstName,
      lastName: employee.lastName,
      designation: employee.designation?.name ?? null,
      email: employee.email,
      panMasked: maskPan(plain.panNumber),
      bankName: employee.bankName,
      accountNumberMasked: maskAccountNumber(plain.accountNumber),
    },
    financialYear,
    month,
    monthLabel,
    earnings: {
      basicMonthly,
      hraMonthly,
      specialAllowanceMonthly,
      incentives: incentiveLines,
      grossMonthly,
    },
    deductions: {
      tdsMonthly,
      professionalTaxMonthly,
      totalDeductions,
    },
    netPay: grossMonthly - totalDeductions,
    generatedAt: new Date().toISOString(),
  }
}

const payslipSelect = {
  id: true,
  financialYear: true,
  month: true,
  snapshot: true,
  generatedAt: true,
  fileId: true,
} satisfies Prisma.HrPayslipSelect

async function toPublicPayslip(row: Prisma.HrPayslipGetPayload<{ select: typeof payslipSelect }>) {
  return {
    id: row.id,
    financialYear: row.financialYear,
    month: row.month,
    generatedAt: row.generatedAt,
    snapshot: row.snapshot as unknown as PayslipSnapshot,
    downloadUrl: row.fileId ? await resolveDownloadUrl(row.fileId) : null,
  }
}

async function resolveDownloadUrl(fileId: string): Promise<string | null> {
  const file = await prisma.hrFile.findUnique({
    where: { id: fileId },
    select: { storageKey: true },
  })
  if (!file) return null
  return createDownloadUrl(file.storageKey, 'payslip.pdf')
}

export async function previewPayslipRun(financialYear: string, month: number) {
  const rows = await prisma.hrEmployee.findMany({
    where: { deletedAt: null, status: HrEmployeeStatus.ACTIVE },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      joiningDate: true,
      relievingDate: true,
      salaryStructures: {
        where: { financialYear },
        select: { basic: true, hra: true, specialAllowance: true },
      },
      payslips: { where: { financialYear, month }, select: { generatedAt: true } },
    },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  })

  return rows.map((row) => {
    const structure = row.salaryStructures[0]
    const hasBreakdown =
      structure !== undefined &&
      toNumber(structure.basic) + toNumber(structure.hra) + toNumber(structure.specialAllowance) > 0
    const employed = employedMonths(financialYear, {
      joiningDate: row.joiningDate,
      relievingDate: row.relievingDate,
    }).includes(month)

    const state = payslipRunState({
      hasPayslip: row.payslips.length > 0,
      employed,
      hasBreakdown,
    })

    return {
      id: row.id,
      employeeCode: row.employeeCode,
      firstName: row.firstName,
      lastName: row.lastName,
      state,
      generatedAt: row.payslips[0]?.generatedAt ?? null,
    }
  })
}

export async function listPayslips(employeeId: string) {
  const rows = await prisma.hrPayslip.findMany({
    where: { employeeId },
    select: payslipSelect,
    orderBy: [{ financialYear: 'desc' }, { month: 'desc' }],
  })
  return Promise.all(rows.map(toPublicPayslip))
}

export async function getPayslip(employeeId: string, financialYear: string, month: number) {
  const row = await prisma.hrPayslip.findUnique({
    where: { employeeId_financialYear_month: { employeeId, financialYear, month } },
    select: payslipSelect,
  })
  return row ? toPublicPayslip(row) : null
}

/**
 * Renders and stores a fresh payslip, replacing any prior one for the same
 * employee+FY+month. Regeneration is a deliberate, visible admin action —
 * distinct from the "never silently rewrite a downloaded payslip" guarantee
 * the schema's own doc comment describes, which is about ordinary salary
 * edits elsewhere never reaching an already-generated payslip on their own.
 */
export async function generatePayslip(
  employeeId: string,
  financialYear: string,
  month: number,
  generatedById: string,
) {
  const snapshot = await assembleSnapshot(employeeId, financialYear, month)
  const html = renderPayslipHtml(snapshot)
  const pdf = await renderHtmlToPdf(html)

  const storageKey = buildStorageKey('payslip', `${employeeId}-${financialYear}-${month}.pdf`)
  await putObject(storageKey, pdf, 'application/pdf')

  const file = await prisma.hrFile.create({
    data: {
      scope: HrFileScope.PAYSLIP,
      storageKey,
      driver: 's3',
      originalName: `payslip-${financialYear}-${month}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: pdf.byteLength,
      uploadedById: generatedById,
      isComplete: true,
    },
    select: { id: true },
  })

  const existing = await prisma.hrPayslip.findUnique({
    where: { employeeId_financialYear_month: { employeeId, financialYear, month } },
    select: { id: true, fileId: true },
  })

  const row = await prisma.hrPayslip.upsert({
    where: { employeeId_financialYear_month: { employeeId, financialYear, month } },
    create: {
      employeeId,
      financialYear,
      month,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      fileId: file.id,
      generatedById,
    },
    update: {
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      fileId: file.id,
      generatedById,
      generatedAt: new Date(),
    },
    select: payslipSelect,
  })

  // The old file is now unreferenced — remove both its row and its bytes so
  // regenerating a payslip repeatedly doesn't leak storage. Best-effort: a
  // failure here leaves an orphaned file, not a broken payslip.
  if (existing?.fileId && existing.fileId !== file.id) {
    const oldFile = await prisma.hrFile.findUnique({
      where: { id: existing.fileId },
      select: { storageKey: true },
    })
    await prisma.hrFile.delete({ where: { id: existing.fileId } }).catch(() => undefined)
    if (oldFile) await deleteObject(oldFile.storageKey).catch(() => undefined)
  }

  return toPublicPayslip(row)
}

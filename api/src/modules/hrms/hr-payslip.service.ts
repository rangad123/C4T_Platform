import { HrFileScope, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { putObject, buildStorageKey, createDownloadUrl, deleteObject } from '../../lib/storage.js'
import { renderHtmlToPdf } from '../../lib/hrms/hr-pdf.js'
import {
  decryptHrFinancialDetails,
  maskPan,
  maskAccountNumber,
} from '../../lib/hrms/hr-encryption.js'
import { financialYearMonths } from '../../lib/hrms/financial-year.js'
import { renderPayslipHtml, type PayslipSnapshot } from './hr-payslip-template.js'

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
    },
  })
  if (!employee) throw new NotFoundError('Employee')

  const [salaryStructure, incentives, deduction, professionalTax] = await Promise.all([
    prisma.hrSalaryStructure.findUnique({
      where: { employeeId_financialYear: { employeeId, financialYear } },
      select: { basic: true, hra: true, specialAllowance: true },
    }),
    prisma.hrMonthlyIncentive.findMany({
      where: { employeeId, financialYear, month },
      select: { amount: true, incentiveType: { select: { name: true } } },
    }),
    prisma.hrMonthlyTaxDeduction.findUnique({
      where: { employeeId_financialYear_month: { employeeId, financialYear, month } },
      select: { amount: true },
    }),
    prisma.hrProfessionalTaxRate.findUnique({
      where: { financialYear },
      select: { monthlyAmount: true },
    }),
  ])

  const plain = employee.secureFinancialDetails
    ? decryptHrFinancialDetails(Buffer.from(employee.secureFinancialDetails), employeeId)
    : {}

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
  const professionalTaxMonthly = professionalTax ? toNumber(professionalTax.monthlyAmount) : 0
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

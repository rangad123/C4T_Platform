import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { computeTax, type TaxSlabBand } from '../../lib/hrms/hr-tax-engine.js'
import { sumMonthlyIncentives } from './hr-salary.service.js'
import type { UpsertTaxSlabInput } from './hr-tax.schema.js'

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber()
}

const taxSlabSelect = {
  id: true,
  financialYear: true,
  regime: true,
  slabs: true,
  standardDeduction: true,
  cessRatePercent: true,
  rebate87ALimit: true,
  rebate87AMaxAmount: true,
  updatedAt: true,
} satisfies Prisma.HrTaxSlabSelect

function toPublicTaxSlab(row: Prisma.HrTaxSlabGetPayload<{ select: typeof taxSlabSelect }>) {
  return {
    ...row,
    slabs: row.slabs as unknown as TaxSlabBand[],
    standardDeduction: toNumber(row.standardDeduction),
    cessRatePercent: toNumber(row.cessRatePercent),
    rebate87ALimit: toNumber(row.rebate87ALimit),
    rebate87AMaxAmount: toNumber(row.rebate87AMaxAmount),
  }
}

export async function listTaxSlabs(financialYear?: string) {
  const rows = await prisma.hrTaxSlab.findMany({
    where: financialYear ? { financialYear } : {},
    select: taxSlabSelect,
    orderBy: [{ financialYear: 'desc' }, { regime: 'asc' }],
  })
  return rows.map(toPublicTaxSlab)
}

export async function upsertTaxSlab(input: UpsertTaxSlabInput) {
  const row = await prisma.hrTaxSlab.upsert({
    where: { financialYear_regime: { financialYear: input.financialYear, regime: input.regime } },
    create: {
      financialYear: input.financialYear,
      regime: input.regime,
      slabs: input.slabs,
      standardDeduction: input.standardDeduction,
      cessRatePercent: input.cessRatePercent,
      rebate87ALimit: input.rebate87ALimit,
      rebate87AMaxAmount: input.rebate87AMaxAmount,
    },
    update: {
      slabs: input.slabs,
      standardDeduction: input.standardDeduction,
      cessRatePercent: input.cessRatePercent,
      rebate87ALimit: input.rebate87ALimit,
      rebate87AMaxAmount: input.rebate87AMaxAmount,
    },
    select: taxSlabSelect,
  })
  return toPublicTaxSlab(row)
}

export async function deleteTaxSlab(id: string): Promise<void> {
  const existing = await prisma.hrTaxSlab.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new NotFoundError('Tax slab')
  await prisma.hrTaxSlab.delete({ where: { id } })
}

/**
 * Reads every input the brief's 20-line computation needs and runs it
 * through the pure engine. Nothing here is hardcoded: the slab/rate/cess/
 * rebate configuration comes from `HrTaxSlab`, salary from
 * `HrSalaryStructure` + actual `HrMonthlyIncentive` rows, deductions from
 * verified `HrInvestmentDeclaration` rows, and TDS-to-date from
 * `HrMonthlyTaxDeduction`.
 */
export async function computeEmployeeTax(employeeId: string, financialYear: string) {
  const employee = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { id: true, taxRegime: true },
  })
  if (!employee) throw new NotFoundError('Employee')

  const [salaryStructure, actualIncentives, investmentTotal, tdsTotal, slab] = await Promise.all([
    prisma.hrSalaryStructure.findUnique({
      where: { employeeId_financialYear: { employeeId, financialYear } },
      select: { totalFixedAnnual: true, totalVariableAnnual: true },
    }),
    sumMonthlyIncentives(employeeId, financialYear),
    prisma.hrInvestmentDeclaration.findMany({
      where: { employeeId, financialYear },
      select: { declaredAmount: true, verifiedAmount: true },
    }),
    prisma.hrMonthlyTaxDeduction.aggregate({
      where: { employeeId, financialYear },
      _sum: { amount: true },
    }),
    prisma.hrTaxSlab.findUnique({
      where: { financialYear_regime: { financialYear, regime: employee.taxRegime } },
      select: taxSlabSelect,
    }),
  ])

  if (!slab) {
    throw new NotFoundError(
      `Tax slab configuration for ${financialYear} (${employee.taxRegime} regime)`,
    )
  }

  const totalFixedAnnual = salaryStructure ? toNumber(salaryStructure.totalFixedAnnual) : 0
  // Actual incentives paid this FY are the real figure; the salary
  // structure's own variable total is only an estimate set at structure time
  // and is used as a fallback before any month has been logged.
  const totalVariableAnnual =
    actualIncentives > 0
      ? actualIncentives
      : salaryStructure
        ? toNumber(salaryStructure.totalVariableAnnual)
        : 0

  const chapterVIADeductions = investmentTotal.reduce((sum, row) => {
    const amount = row.verifiedAmount ?? row.declaredAmount
    return sum + toNumber(amount)
  }, 0)

  const tdsDeductedTillDate = tdsTotal._sum.amount ? toNumber(tdsTotal._sum.amount) : 0

  const result = computeTax({
    grossSalaryAnnual: totalFixedAnnual + totalVariableAnnual,
    chapterVIADeductions,
    regime: employee.taxRegime,
    slabConfig: toPublicTaxSlab(slab),
    tdsDeductedTillDate,
  })

  return {
    financialYear,
    regime: employee.taxRegime,
    hasSalaryStructure: Boolean(salaryStructure),
    ...result,
  }
}

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { computeTax, type TaxSlabBand } from '../../lib/hrms/hr-tax-engine.js'
import {
  buildTdsSchedule,
  employedMonths,
  type TdsScheduleEntry,
} from '../../lib/hrms/hr-tds-schedule.js'
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
    select: { id: true, taxRegime: true, joiningDate: true, relievingDate: true },
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

  /**
   * Fixed pay is the ANNUAL figure, so for someone who was on the payroll for
   * only part of the year it has to be cut down to the months they were.
   *
   * Without this, a person who joined in August was taxed as though they had
   * earned twelve months of salary, and the figure that fed their monthly TDS
   * was a third too high. Someone employed all year is unaffected: twelve of
   * twelve months is the whole amount.
   */
  const monthsEmployed = employedMonths(financialYear, {
    joiningDate: employee.joiningDate,
    relievingDate: employee.relievingDate,
  }).length
  const totalFixedAnnual = salaryStructure
    ? toNumber(salaryStructure.totalFixedAnnual) * (monthsEmployed / 12)
    : 0
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
    monthsEmployed,
    ...result,
  }
}

export interface CalculateTdsResult {
  /** The months that were filled in, with the amount for each. */
  created: TdsScheduleEntry[]
  /** Why nothing was calculated, when that is the case. */
  skipped: string | null
}

/**
 * Fills in the monthly TDS for every month up to `throughMonth` that has no
 * figure yet.
 *
 * ── NEVER OVERWRITES
 *
 * A month that already has an amount keeps it — one an admin typed, or one
 * carried over from the old system — and simply counts as already deducted.
 * There is no flag on the row saying who set it, so the only safe rule is
 * that anything present is authoritative. To recalculate a month, delete its
 * entry and run this again.
 *
 * ── LENIENT vs STRICT
 *
 * `lenient` is for payslip generation, which must not fail because tax could
 * not be worked out: a year with no slab configuration, or someone with no
 * salary structure, simply gets no calculated TDS and the payslip goes ahead
 * on whatever is recorded. Called from the admin's own Calculate button it is
 * strict, so a missing slab configuration is reported rather than skipped
 * silently and the admin is told why nothing happened.
 */
export async function calculateMonthlyTds(
  employeeId: string,
  financialYear: string,
  throughMonth: number,
  { lenient = false }: { lenient?: boolean } = {},
): Promise<CalculateTdsResult> {
  const employee = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { joiningDate: true, relievingDate: true },
  })
  if (!employee) throw new NotFoundError('Employee')

  let annualLiability: number
  try {
    const tax = await computeEmployeeTax(employeeId, financialYear)
    if (!tax.hasSalaryStructure) {
      return { created: [], skipped: `No salary structure is recorded for ${financialYear}.` }
    }
    annualLiability = tax.totalTaxLiability
  } catch (error) {
    if (lenient && error instanceof NotFoundError) {
      return { created: [], skipped: error.message }
    }
    throw error
  }

  const rows = await prisma.hrMonthlyTaxDeduction.findMany({
    where: { employeeId, financialYear },
    select: { month: true, amount: true },
  })
  const recorded = new Map(rows.map((row) => [row.month, toNumber(row.amount)]))

  const created = buildTdsSchedule({
    financialYear,
    window: { joiningDate: employee.joiningDate, relievingDate: employee.relievingDate },
    annualLiability,
    recorded,
    throughMonth,
  })

  if (created.length > 0) {
    await prisma.hrMonthlyTaxDeduction.createMany({
      data: created.map((entry) => ({
        employeeId,
        financialYear,
        month: entry.month,
        amount: entry.amount,
      })),
      // Two runs at once (a bulk payslip run and an admin clicking Calculate)
      // would otherwise fail on the unique key for the same month.
      skipDuplicates: true,
    })
  }

  return { created, skipped: null }
}

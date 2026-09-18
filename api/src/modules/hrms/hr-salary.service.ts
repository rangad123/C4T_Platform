import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import type {
  UpsertSalaryStructureInput,
  CreateOldSalaryInput,
  CreateMonthlyIncentiveInput,
} from './hr-salary.schema.js'

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber()
}

const salaryStructureSelect = {
  id: true,
  financialYear: true,
  basic: true,
  hra: true,
  specialAllowance: true,
  totalFixedAnnual: true,
  performanceIncentive: true,
  projectIncentive: true,
  extraHoursIncentive: true,
  totalVariableAnnual: true,
  updatedAt: true,
} satisfies Prisma.HrSalaryStructureSelect

function toPublicSalaryStructure(
  row: Prisma.HrSalaryStructureGetPayload<{ select: typeof salaryStructureSelect }>,
) {
  return {
    ...row,
    basic: toNumber(row.basic),
    hra: toNumber(row.hra),
    specialAllowance: toNumber(row.specialAllowance),
    totalFixedAnnual: toNumber(row.totalFixedAnnual),
    performanceIncentive: toNumber(row.performanceIncentive),
    projectIncentive: toNumber(row.projectIncentive),
    extraHoursIncentive: toNumber(row.extraHoursIncentive),
    totalVariableAnnual: toNumber(row.totalVariableAnnual),
  }
}

async function assertEmployeeExists(employeeId: string): Promise<void> {
  const exists = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { id: true },
  })
  if (!exists) throw new NotFoundError('Employee')
}

export async function getSalaryStructure(employeeId: string, financialYear: string) {
  const row = await prisma.hrSalaryStructure.findUnique({
    where: { employeeId_financialYear: { employeeId, financialYear } },
    select: salaryStructureSelect,
  })
  return row ? toPublicSalaryStructure(row) : null
}

/**
 * `totalFixedAnnual`/`totalVariableAnnual` are always recomputed from the
 * components here — never trusted from `input`, which does not even carry
 * them (see the schema's own doc comment).
 */
export async function upsertSalaryStructure(employeeId: string, input: UpsertSalaryStructureInput) {
  await assertEmployeeExists(employeeId)

  const totalFixedAnnual = input.basic + input.hra + input.specialAllowance
  const totalVariableAnnual =
    input.performanceIncentive + input.projectIncentive + input.extraHoursIncentive

  const row = await prisma.hrSalaryStructure.upsert({
    where: { employeeId_financialYear: { employeeId, financialYear: input.financialYear } },
    create: {
      employeeId,
      financialYear: input.financialYear,
      basic: input.basic,
      hra: input.hra,
      specialAllowance: input.specialAllowance,
      totalFixedAnnual,
      performanceIncentive: input.performanceIncentive,
      projectIncentive: input.projectIncentive,
      extraHoursIncentive: input.extraHoursIncentive,
      totalVariableAnnual,
    },
    update: {
      basic: input.basic,
      hra: input.hra,
      specialAllowance: input.specialAllowance,
      totalFixedAnnual,
      performanceIncentive: input.performanceIncentive,
      projectIncentive: input.projectIncentive,
      extraHoursIncentive: input.extraHoursIncentive,
      totalVariableAnnual,
    },
    select: salaryStructureSelect,
  })
  return toPublicSalaryStructure(row)
}

const oldSalarySelect = {
  id: true,
  ctc: true,
  fromDate: true,
  toDate: true,
  createdAt: true,
} satisfies Prisma.HrOldSalarySelect

export async function listOldSalaries(employeeId: string) {
  const rows = await prisma.hrOldSalary.findMany({
    where: { employeeId },
    select: oldSalarySelect,
    orderBy: { fromDate: 'desc' },
  })
  return rows.map((row) => ({ ...row, ctc: toNumber(row.ctc) }))
}

export async function createOldSalary(employeeId: string, input: CreateOldSalaryInput) {
  await assertEmployeeExists(employeeId)
  const row = await prisma.hrOldSalary.create({
    data: { employeeId, ctc: input.ctc, fromDate: input.fromDate, toDate: input.toDate },
    select: oldSalarySelect,
  })
  return { ...row, ctc: toNumber(row.ctc) }
}

export async function deleteOldSalary(employeeId: string, id: string): Promise<void> {
  const existing = await prisma.hrOldSalary.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Old salary record')
  await prisma.hrOldSalary.delete({ where: { id } })
}

const monthlyIncentiveSelect = {
  id: true,
  financialYear: true,
  month: true,
  amount: true,
  createdAt: true,
  incentiveType: { select: { id: true, name: true } },
} satisfies Prisma.HrMonthlyIncentiveSelect

export async function listMonthlyIncentives(employeeId: string, financialYear: string) {
  const rows = await prisma.hrMonthlyIncentive.findMany({
    where: { employeeId, financialYear },
    select: monthlyIncentiveSelect,
    orderBy: [{ month: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map((row) => ({ ...row, amount: toNumber(row.amount) }))
}

/** Total actual incentives paid for the FY — the tax engine's real variable-pay input. */
export async function sumMonthlyIncentives(
  employeeId: string,
  financialYear: string,
): Promise<number> {
  const result = await prisma.hrMonthlyIncentive.aggregate({
    where: { employeeId, financialYear },
    _sum: { amount: true },
  })
  return result._sum.amount ? toNumber(result._sum.amount) : 0
}

export async function createMonthlyIncentive(
  employeeId: string,
  input: CreateMonthlyIncentiveInput,
) {
  await assertEmployeeExists(employeeId)
  const incentiveType = await prisma.hrIncentiveType.findFirst({
    where: { id: input.incentiveTypeId, isActive: true },
    select: { id: true },
  })
  if (!incentiveType) throw new NotFoundError('Incentive type')

  const row = await prisma.hrMonthlyIncentive.create({
    data: {
      employeeId,
      financialYear: input.financialYear,
      month: input.month,
      incentiveTypeId: input.incentiveTypeId,
      amount: input.amount,
    },
    select: monthlyIncentiveSelect,
  })
  return { ...row, amount: toNumber(row.amount) }
}

export async function deleteMonthlyIncentive(employeeId: string, id: string): Promise<void> {
  const existing = await prisma.hrMonthlyIncentive.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Monthly incentive')
  await prisma.hrMonthlyIncentive.delete({ where: { id } })
}

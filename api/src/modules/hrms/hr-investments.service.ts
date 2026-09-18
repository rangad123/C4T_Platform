import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import type {
  CreateDeclarationInput,
  UpdateDeclarationInput,
  CreateMonthlyDeductionInput,
} from './hr-investments.schema.js'

function toNumber(value: Prisma.Decimal): number {
  return value.toNumber()
}

async function assertEmployeeExists(employeeId: string): Promise<void> {
  const exists = await prisma.hrEmployee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { id: true },
  })
  if (!exists) throw new NotFoundError('Employee')
}

const declarationSelect = {
  id: true,
  financialYear: true,
  description: true,
  declaredAmount: true,
  verifiedAmount: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
  section: { select: { id: true, code: true, name: true } },
  verifiedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.HrInvestmentDeclarationSelect

function toPublicDeclaration(
  row: Prisma.HrInvestmentDeclarationGetPayload<{ select: typeof declarationSelect }>,
) {
  return {
    ...row,
    declaredAmount: toNumber(row.declaredAmount),
    verifiedAmount: row.verifiedAmount ? toNumber(row.verifiedAmount) : null,
  }
}

export async function listDeclarations(employeeId: string, financialYear: string) {
  const rows = await prisma.hrInvestmentDeclaration.findMany({
    where: { employeeId, financialYear },
    select: declarationSelect,
    orderBy: { section: { code: 'asc' } },
  })
  return rows.map(toPublicDeclaration)
}

export async function createDeclaration(employeeId: string, input: CreateDeclarationInput) {
  await assertEmployeeExists(employeeId)
  const section = await prisma.hrInvestmentSection.findFirst({
    where: { id: input.sectionId, isActive: true },
    select: { id: true },
  })
  if (!section) throw new NotFoundError('Investment section')

  const row = await prisma.hrInvestmentDeclaration.create({
    data: {
      employeeId,
      financialYear: input.financialYear,
      sectionId: input.sectionId,
      description: input.description ?? null,
      declaredAmount: input.declaredAmount,
    },
    select: declarationSelect,
  })
  return toPublicDeclaration(row)
}

export async function updateDeclaration(
  employeeId: string,
  id: string,
  input: UpdateDeclarationInput,
) {
  const existing = await prisma.hrInvestmentDeclaration.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Investment declaration')

  const row = await prisma.hrInvestmentDeclaration.update({
    where: { id },
    data: {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.declaredAmount !== undefined ? { declaredAmount: input.declaredAmount } : {}),
    },
    select: declarationSelect,
  })
  return toPublicDeclaration(row)
}

export async function verifyDeclaration(
  employeeId: string,
  id: string,
  verifiedById: string,
  verifiedAmount: number,
) {
  const existing = await prisma.hrInvestmentDeclaration.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Investment declaration')

  const row = await prisma.hrInvestmentDeclaration.update({
    where: { id },
    data: { verifiedAmount, verifiedById, verifiedAt: new Date() },
    select: declarationSelect,
  })
  return toPublicDeclaration(row)
}

export async function deleteDeclaration(employeeId: string, id: string): Promise<void> {
  const existing = await prisma.hrInvestmentDeclaration.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Investment declaration')
  await prisma.hrInvestmentDeclaration.delete({ where: { id } })
}

const deductionSelect = {
  id: true,
  financialYear: true,
  month: true,
  amount: true,
} satisfies Prisma.HrMonthlyTaxDeductionSelect

export async function listMonthlyDeductions(employeeId: string, financialYear: string) {
  const rows = await prisma.hrMonthlyTaxDeduction.findMany({
    where: { employeeId, financialYear },
    select: deductionSelect,
    orderBy: { month: 'asc' },
  })
  return rows.map((row) => ({ ...row, amount: toNumber(row.amount) }))
}

export async function upsertMonthlyDeduction(
  employeeId: string,
  input: CreateMonthlyDeductionInput,
) {
  await assertEmployeeExists(employeeId)
  const row = await prisma.hrMonthlyTaxDeduction.upsert({
    where: {
      employeeId_financialYear_month: {
        employeeId,
        financialYear: input.financialYear,
        month: input.month,
      },
    },
    create: {
      employeeId,
      financialYear: input.financialYear,
      month: input.month,
      amount: input.amount,
    },
    update: { amount: input.amount },
    select: deductionSelect,
  })
  return { ...row, amount: toNumber(row.amount) }
}

export async function deleteMonthlyDeduction(employeeId: string, id: string): Promise<void> {
  const existing = await prisma.hrMonthlyTaxDeduction.findFirst({
    where: { id, employeeId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('Monthly tax deduction')
  await prisma.hrMonthlyTaxDeduction.delete({ where: { id } })
}

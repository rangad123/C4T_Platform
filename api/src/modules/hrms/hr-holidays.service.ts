import { prisma } from '../../lib/prisma.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import type { CreateHolidayInput } from './hr-holidays.schema.js'

const holidaySelect = { id: true, year: true, date: true, name: true }

export async function listHolidays(year: number) {
  return prisma.hrHoliday.findMany({
    where: { year },
    select: holidaySelect,
    orderBy: { date: 'asc' },
  })
}

/** For hr-calendar.ts callers that need holiday dates across a range spanning two calendar years. */
export async function listHolidayDatesForYears(years: readonly number[]) {
  const rows = await prisma.hrHoliday.findMany({
    where: { year: { in: [...years] } },
    select: { date: true },
  })
  return rows.map((row) => row.date)
}

/**
 * Duplicate-safe at the DATABASE level (`@@unique([year, date])`), not just
 * checked here first — the direct fix for "prevent duplicate holidays for
 * the same date." `year` is always derived from `date`, never trusted from
 * the client, so the two can never disagree.
 */
export async function createHoliday(input: CreateHolidayInput) {
  const year = input.date.getUTCFullYear()
  try {
    return await prisma.hrHoliday.create({
      data: { year, date: input.date, name: input.name },
      select: holidaySelect,
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new ConflictError('A holiday is already recorded for this date')
    }
    throw error
  }
}

export async function deleteHoliday(id: string): Promise<void> {
  const existing = await prisma.hrHoliday.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new NotFoundError('Holiday')
  await prisma.hrHoliday.delete({ where: { id } })
}

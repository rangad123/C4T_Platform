/**
 * One-off: seed the four HRMS catalog tables with a reasonable default set,
 * so Phase 1's Add Employee / Investments / Salary forms have real dropdown
 * data to render against instead of an empty picker. Idempotent — upserts by
 * the unique key, so it is safe to run again after adding a row here.
 *
 *   npx tsx scripts/hrms/seed-catalog.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const DESIGNATIONS = [
  'Software Engineer',
  'Senior Software Engineer',
  'QA Engineer',
  'Senior QA Engineer',
  'Test Lead',
  'Project Manager',
  'Account Manager',
  'HR Executive',
  'HR Manager',
  'Finance Executive',
  'Business Analyst',
  'Director',
]

const LEAVE_TYPES: { name: string; defaultAnnualDays: number }[] = [
  { name: 'Casual leave', defaultAnnualDays: 12 },
  { name: 'Sick leave', defaultAnnualDays: 12 },
  { name: 'Earned leave', defaultAnnualDays: 15 },
  { name: 'Maternity leave', defaultAnnualDays: 182 },
  { name: 'Paternity leave', defaultAnnualDays: 15 },
  { name: 'Unpaid leave', defaultAnnualDays: 0 },
]

const INCENTIVE_TYPES = [
  'Performance incentive',
  'Referral bonus',
  'Project completion bonus',
  'Festival bonus',
  'Retention bonus',
]

// Chapter VIA + the other sections the spec's Investments module asks for —
// see the doc comment on HrInvestmentSection in schema.prisma.
const INVESTMENT_SECTIONS: { code: string; name: string }[] = [
  { code: '80C', name: 'Life insurance, PF, ELSS, tuition fees and similar' },
  { code: '80CCD(1B)', name: 'National Pension System — additional' },
  { code: '80D', name: 'Medical insurance premium' },
  { code: '80E', name: 'Interest on education loan' },
  { code: '80EE', name: 'Interest on home loan — first-time buyers' },
  { code: '80EEA', name: 'Interest on affordable housing loan' },
  { code: '80EEB', name: 'Interest on electric vehicle loan' },
  { code: '24', name: 'Interest on housing loan (self-occupied)' },
  { code: '10(13A)', name: 'House rent allowance exemption' },
]

async function main(): Promise<void> {
  for (const name of DESIGNATIONS) {
    await prisma.hrDesignation.upsert({ where: { name }, update: {}, create: { name } })
  }

  for (const { name, defaultAnnualDays } of LEAVE_TYPES) {
    await prisma.hrLeaveType.upsert({
      where: { name },
      update: { defaultAnnualDays },
      create: { name, defaultAnnualDays },
    })
  }

  for (const name of INCENTIVE_TYPES) {
    await prisma.hrIncentiveType.upsert({ where: { name }, update: {}, create: { name } })
  }

  for (const { code, name } of INVESTMENT_SECTIONS) {
    await prisma.hrInvestmentSection.upsert({
      where: { code },
      update: { name },
      create: { code, name },
    })
  }

  console.log(
    `seeded ${DESIGNATIONS.length} designations, ${LEAVE_TYPES.length} leave types, ` +
      `${INCENTIVE_TYPES.length} incentive types, ${INVESTMENT_SECTIONS.length} investment sections`,
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })

/**
 * One-off: seed a representative tax slab configuration for a financial
 * year so the Tax Calculation engine has something real to compute against
 * in dev. Idempotent — upserts by (financialYear, regime).
 *
 *   npx tsx scripts/hrms/seed-tax-slabs.ts 2026-2027
 *
 * These figures are a reasonable current-law approximation, NOT hardcoded
 * into the engine itself — see hr-tax-engine.ts's own doc comment. An admin
 * can edit them for any year via PUT /v1/hrms/tax-slabs once that UI exists;
 * this script exists only to give a fresh environment a starting point.
 */
import { PrismaClient, HrTaxRegime } from '@prisma/client'

/**
 * Flat monthly professional tax. 200 is what the old HR system deducted on
 * every payslip it ever issued, regardless of salary — see the note on
 * HrProfessionalTaxRate. Editable per year rather than compiled in.
 */
const PROFESSIONAL_TAX_MONTHLY = 200

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const financialYear = process.argv[2]
  if (!financialYear || !/^\d{4}-\d{4}$/.test(financialYear)) {
    throw new Error('usage: seed-tax-slabs.ts <financial-year, e.g. 2026-2027>')
  }

  await prisma.hrTaxSlab.upsert({
    where: { financialYear_regime: { financialYear, regime: HrTaxRegime.NEW } },
    update: {},
    create: {
      financialYear,
      regime: HrTaxRegime.NEW,
      slabs: [
        { upTo: 400_000, rate: 0 },
        { upTo: 800_000, rate: 5 },
        { upTo: 1_200_000, rate: 10 },
        { upTo: 1_600_000, rate: 15 },
        { upTo: 2_000_000, rate: 20 },
        { upTo: 2_400_000, rate: 25 },
        { upTo: null, rate: 30 },
      ],
      standardDeduction: 75_000,
      cessRatePercent: 4,
      rebate87ALimit: 1_200_000,
      rebate87AMaxAmount: 60_000,
    },
  })

  await prisma.hrTaxSlab.upsert({
    where: { financialYear_regime: { financialYear, regime: HrTaxRegime.OLD } },
    update: {},
    create: {
      financialYear,
      regime: HrTaxRegime.OLD,
      slabs: [
        { upTo: 250_000, rate: 0 },
        { upTo: 500_000, rate: 5 },
        { upTo: 1_000_000, rate: 20 },
        { upTo: null, rate: 30 },
      ],
      standardDeduction: 50_000,
      cessRatePercent: 4,
      rebate87ALimit: 500_000,
      rebate87AMaxAmount: 12_500,
    },
  })

  await prisma.hrProfessionalTaxRate.upsert({
    where: { financialYear },
    update: {},
    create: { financialYear, monthlyAmount: PROFESSIONAL_TAX_MONTHLY },
  })

  console.log(
    `seeded tax slabs (NEW + OLD regime) and professional tax ` +
      `(${PROFESSIONAL_TAX_MONTHLY}/month) for ${financialYear}`,
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

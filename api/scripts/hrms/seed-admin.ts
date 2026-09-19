/**
 * One-off: create the first HRMS admin so there's a way to log in at all.
 * Not wired into any migration runner — HRMS starts with zero rows, unlike
 * the platform side which migrated legacy data. Run once per environment:
 *
 *   npx tsx scripts/hrms/seed-admin.ts <email> <password>
 */
import { PrismaClient, HrRole } from '@prisma/client'
import { hashPassword } from '../../src/lib/password.js'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2)
  if (!email || !password) {
    throw new Error('usage: seed-admin.ts <email> <password>')
  }
  if (password.length < 12) {
    throw new Error('password must be at least 12 characters')
  }

  const existing = await prisma.hrEmployee.findUnique({ where: { email } })
  if (existing) {
    console.log(`already exists: ${email} (${existing.employeeCode})`)
    return
  }

  // Same shape the service issues: yyyymm of the joining date plus a running
  // number. Seeding EMP-0001 here and then issuing 2026090001 for the first
  // real hire would reintroduce exactly the mixed formats this replaced.
  const joining = new Date()
  const year = joining.getUTCFullYear()
  const month = String(joining.getUTCMonth() + 1).padStart(2, '0')
  const count = await prisma.hrEmployee.count()
  const employeeCode = `${year}${month}${String(count + 1).padStart(4, '0')}`

  const employee = await prisma.hrEmployee.create({
    data: {
      employeeCode,
      firstName: 'HR',
      lastName: 'Admin',
      email,
      passwordHash: await hashPassword(password),
      role: HrRole.ADMIN,
      joiningDate: new Date(),
    },
  })

  console.log(`created ${employee.employeeCode} <${employee.email}> as ADMIN`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })

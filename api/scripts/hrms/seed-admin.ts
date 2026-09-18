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

  const count = await prisma.hrEmployee.count()
  const employeeCode = `EMP-${String(count + 1).padStart(4, '0')}`

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

/**
 * End-to-end proof that a legacy MySQL password still works.
 *
 * Creates a throwaway user whose password is stored exactly as the legacy
 * platform would have stored it — a bare MD5 hex digest in a varchar(50) — then
 * signs in through the real service and asserts three things:
 *
 *   1. the sign-in succeeds;
 *   2. the stored hash is silently upgraded to Argon2id; and
 *   3. the SAME password still works on the second attempt, against the new hash.
 *
 * Run:  npx tsx scripts/verify-legacy-login.ts
 * The user is deleted at the end, including on failure.
 */
import { createHash } from 'node:crypto'
import { PasswordAlgo, Role, UserStatus } from '@prisma/client'
import { prisma } from '../src/lib/prisma.js'
import { login } from '../src/modules/auth/auth.service.js'

const EMAIL = `legacy-check-${Date.now()}@example.com`
const PASSWORD = 'LegacyPass123'

async function main() {
  const legacyDigest = createHash('md5').update(PASSWORD, 'utf8').digest('hex')
  console.log(`legacy digest : ${legacyDigest} (${legacyDigest.length} chars)`)

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: legacyDigest,
      passwordAlgo: PasswordAlgo.LEGACY_MD5,
      role: Role.TESTER,
      status: UserStatus.ACTIVE,
      firstName: 'Legacy',
    },
    select: { id: true },
  })

  try {
    // 1 — the legacy password is accepted
    await login({ email: EMAIL, password: PASSWORD }, {})
    console.log('1. legacy sign-in            : OK')

    // 2 — the hash was upgraded in place
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true, passwordAlgo: true },
    })
    const upgraded =
      after.passwordAlgo === PasswordAlgo.ARGON2ID && after.passwordHash?.startsWith('$argon2id$')
    console.log(`2. upgraded to Argon2id      : ${upgraded ? 'OK' : 'FAILED'}`)
    console.log(`   algo now                  : ${after.passwordAlgo}`)
    console.log(`   hash now                  : ${after.passwordHash?.slice(0, 32)}...`)

    // 3 — the same password still works against the new hash
    await login({ email: EMAIL, password: PASSWORD }, {})
    console.log('3. sign-in after upgrade     : OK')

    // 4 — a wrong password is still refused
    let refused = false
    try {
      await login({ email: EMAIL, password: 'WrongPassword123' }, {})
    } catch {
      refused = true
    }
    console.log(`4. wrong password refused    : ${refused ? 'OK' : 'FAILED'}`)

    console.log(upgraded && refused ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED')
    process.exitCode = upgraded && refused ? 0 : 1
  } finally {
    await prisma.session.deleteMany({ where: { userId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
    console.log(`\ncleaned up ${EMAIL}`)
    await prisma.$disconnect()
  }
}

void main()

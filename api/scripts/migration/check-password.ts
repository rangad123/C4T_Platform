import { createHash } from 'node:crypto'
import { migrationEnv } from './config.js'
import { closeLegacyPool, query } from './legacy/client.js'

/**
 * Confirms how the legacy platform hashed passwords, against a REAL account.
 *
 * ── WHY THIS EXISTS
 *
 * `scripts/verify-legacy-login.ts` proves the new platform can verify and
 * upgrade a legacy digest — but it invents the digest itself, so it passes
 * whether or not the real database looks anything like that. It cannot tell
 * you that migrated users will actually be able to sign in.
 *
 * This can. Give it one account whose password you know, and it reads that
 * row from the legacy MySQL and reports which scheme reproduces the stored
 * digest. If nothing matches, the migration must not proceed on the assumption
 * that passwords carry over — see MIGRATION.md, "Passwords".
 *
 * ── SAFETY
 *
 * Read-only, like everything else under scripts/migration. The plaintext you
 * pass is never written anywhere, and the stored digest is only ever printed
 * as a prefix and a length, never in full — a full unsalted digest is
 * effectively the password for any common choice.
 *
 * Run:
 *   npx tsx scripts/migration/check-password.ts someone@example.com 'TheirPassword'
 */

interface LegacyUser {
  usr_id: string
  usr_email: string
  usr_password: string
}

function redact(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)} (${hash.length} chars)`
}

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2)
  if (!email || !password) {
    console.error(
      "Usage: npx tsx scripts/migration/check-password.ts <email> '<password>'\n\n" +
        'Use an account you control — a test account on the legacy platform is ideal.',
    )
    process.exitCode = 1
    return
  }

  const env = migrationEnv()
  const rows = await query<LegacyUser>(
    'SELECT usr_id, usr_email, usr_password FROM `users` WHERE usr_email = ? LIMIT 1',
    [email],
  )

  const user = rows[0]
  if (!user) {
    console.error(`No legacy user with email ${email}`)
    process.exitCode = 1
    return
  }

  const stored = String(user.usr_password ?? '').trim()
  console.log(`\nlegacy user   : usr_id=${user.usr_id} <${user.usr_email}>`)
  console.log(`stored digest : ${redact(stored)}`)

  const isHex = /^[0-9a-fA-F]+$/.test(stored)
  console.log(`looks like hex: ${isHex ? 'yes' : 'NO — not a bare MD5/SHA-1 digest'}`)

  const pepper = env.LEGACY_PASSWORD_PEPPER ?? ''
  if (pepper) console.log('pepper        : set (trying both orderings)')

  // Every scheme a CodeIgniter application of this vintage plausibly used.
  const candidates: { label: string; input: string; algo: 'md5' | 'sha1' }[] = []
  for (const algo of ['md5', 'sha1'] as const) {
    candidates.push({ label: `${algo}(password)`, input: password, algo })
    if (pepper) {
      candidates.push({ label: `${algo}(pepper + password)`, input: `${pepper}${password}`, algo })
      candidates.push({ label: `${algo}(password + pepper)`, input: `${password}${pepper}`, algo })
    }
  }

  console.log('')
  let matched: string | null = null
  for (const c of candidates) {
    const digest = createHash(c.algo).update(c.input, 'utf8').digest('hex')
    const hit = digest.toLowerCase() === stored.toLowerCase()
    console.log(`  ${hit ? 'MATCH  ' : '  ---  '} ${c.label}`)
    if (hit && !matched) matched = c.label
  }

  console.log('')
  if (matched) {
    console.log(`Scheme confirmed: ${matched}`)
    console.log('Legacy passwords will carry over. Migrated users can sign in with')
    console.log('their existing password, and each hash upgrades to Argon2id on first use.')
    return
  }

  console.log('NO SCHEME MATCHED.')
  console.log('')
  console.log('Passwords will NOT carry over as configured. Before migrating, either:')
  console.log('  1. find the hashing code in the legacy PHP (usually a Login controller')
  console.log('     or MY_Auth library) and set LEGACY_PASSWORD_PEPPER if it uses a')
  console.log('     site-wide salt; or')
  console.log('  2. if it uses a PER-USER salt, that salt is not in the users table and')
  console.log('     passwords cannot be migrated — plan a forced password reset for every')
  console.log('     legacy account instead.')
  console.log('')
  console.log('Do not run the migration assuming passwords work until this prints MATCH.')
  process.exitCode = 1
}

main()
  .catch((error: unknown) => {
    console.error('\nFailed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => closeLegacyPool())

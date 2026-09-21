/**
 * Puts the old HRMS's profile pictures onto the employees that were migrated.
 *
 *   npx tsx scripts/hrms/import-profile-pictures.ts --dir <folder> --mode=dry-run
 *   npx tsx scripts/hrms/import-profile-pictures.ts --dir <folder> --mode=full
 *
 * The migration could not bring the pictures across: the old database records
 * only a file NAME per user (`users.user_profile_pic`), and the files sit on the
 * old web server's disk, out of reach over MySQL. Copy them into one folder
 * (from the hosting file manager, keeping their names) and point --dir at it.
 *
 * ── HOW IT MATCHES
 *
 * The old database says which file belongs to which user; the migration kept
 * that user's id as `HrEmployee.legacyId`. So the match is by id, not by
 * guessing from a file name.
 *
 * ── WHAT IT LEAVES ALONE
 *
 * Anyone who already has a picture keeps it, unless --replace is given. A name
 * the database lists but the folder lacks is reported, not an error: some of
 * the eleven may simply not have survived. A file that is not an image the app
 * accepts, or is over the upload limit, is reported and skipped.
 *
 * Re-running is safe: a person who got their picture on the first run is
 * "already has one" on the second.
 *
 * Settings, from the environment (no fallbacks, this repository is public):
 * LEGACY_HRMS_DB_HOST, _USER, _PASSWORD, _NAME, and the app's own DATABASE_URL
 * and storage settings.
 */
import 'dotenv/config'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { HrEmployeeStatus, HrFileScope, HrRole, PrismaClient } from '@prisma/client'
import { assertUploadAllowed, buildStorageKey, putObject } from '../../src/lib/storage.js'
import { findPictureFile, pictureMime } from '../../src/lib/hrms/hr-profile-pictures.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required (the old HRMS database, see .env.example).`)
  return value
}

function argValue(flag: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

type Outcome =
  | 'imported'
  | 'would import'
  | 'already has one'
  | 'file not in folder'
  | 'no such employee'
  | 'not a usable image'
  | 'failed'

async function main(): Promise<void> {
  const dir = argValue('--dir')
  const mode = argValue('--mode') ?? 'dry-run'
  const replace = process.argv.includes('--replace')
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error('--dir must be an existing folder holding the picture files.')
  }
  if (mode !== 'dry-run' && mode !== 'full') throw new Error('--mode must be dry-run or full.')
  const write = mode === 'full'

  const available = readdirSync(dir)
  console.log(`\nProfile pictures — ${write ? 'FULL' : 'DRY RUN, nothing will be written'}`)
  console.log(`Folder: ${dir} (${available.length} files)\n`)

  const legacy = await mysql.createConnection({
    host: required('LEGACY_HRMS_DB_HOST'),
    port: Number(process.env.LEGACY_HRMS_DB_PORT ?? 3306),
    user: required('LEGACY_HRMS_DB_USER'),
    password: required('LEGACY_HRMS_DB_PASSWORD'),
    database: required('LEGACY_HRMS_DB_NAME'),
    connectTimeout: 15000,
  })
  const [rows] = await legacy.query(
    "SELECT user_id, user_profile_pic FROM users WHERE user_profile_pic IS NOT NULL AND user_profile_pic <> ''",
  )
  await legacy.end()
  const wanted = (rows as { user_id: number | string; user_profile_pic: string }[]).map((r) => ({
    legacyId: String(r.user_id),
    fileName: r.user_profile_pic,
  }))

  const prisma = new PrismaClient()
  try {
    const employees = await prisma.hrEmployee.findMany({
      where: { legacyId: { in: wanted.map((w) => w.legacyId) } },
      select: { id: true, legacyId: true, employeeCode: true, profilePictureFileId: true },
    })
    const byLegacy = new Map(employees.map((e) => [e.legacyId, e]))

    const uploader = await prisma.hrEmployee.findFirst({
      where: { role: HrRole.ADMIN, status: HrEmployeeStatus.ACTIVE, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (write && !uploader) throw new Error('No active HR administrator to record as the uploader.')

    const tally = new Map<Outcome, number>()
    for (const { legacyId, fileName } of wanted) {
      const employee = byLegacy.get(legacyId)
      let outcome: Outcome
      let detail = ''

      if (!employee) {
        outcome = 'no such employee'
      } else if (employee.profilePictureFileId && !replace) {
        outcome = 'already has one'
      } else {
        const onDisk = findPictureFile(available, fileName)
        const mime = pictureMime(fileName)
        if (!onDisk) {
          outcome = 'file not in folder'
        } else if (!mime) {
          outcome = 'not a usable image'
          detail = 'unrecognised file type'
        } else {
          const data = readFileSync(join(dir, onDisk))
          try {
            assertUploadAllowed(mime, data.byteLength)
            if (!write) {
              outcome = 'would import'
            } else {
              const storageKey = buildStorageKey('profile_picture', onDisk)
              await putObject(storageKey, data, mime)
              const file = await prisma.hrFile.create({
                data: {
                  scope: HrFileScope.PROFILE_PICTURE,
                  storageKey,
                  driver: process.env.STORAGE_DRIVER ?? 's3',
                  originalName: onDisk,
                  mimeType: mime,
                  sizeBytes: data.byteLength,
                  uploadedById: uploader!.id,
                  isComplete: true,
                },
                select: { id: true },
              })
              await prisma.hrEmployee.update({
                where: { id: employee.id },
                data: { profilePictureFileId: file.id },
              })
              outcome = 'imported'
            }
          } catch (error) {
            outcome = 'not a usable image'
            detail = error instanceof Error ? error.message : String(error)
          }
        }
      }

      tally.set(outcome, (tally.get(outcome) ?? 0) + 1)
      console.log(
        `  ${employee?.employeeCode ?? `legacy user ${legacyId}`}  ${fileName}  →  ${outcome}${detail ? ` (${detail})` : ''}`,
      )
    }

    console.log('\nSummary')
    for (const [outcome, count] of tally) console.log(`  ${outcome}: ${count}`)
    if (!write) console.log('\nNothing was written — this was a dry run.')
    if (tally.has('failed')) process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

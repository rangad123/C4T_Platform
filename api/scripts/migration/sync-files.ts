import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { PrismaClient } from '@prisma/client'

/**
 * Copies the legacy files into S3 and completes the rows that point at them.
 *
 * ── WHY THIS IS A SEPARATE STEP
 *
 * The migration records an attachment as soon as it sees one, because the row
 * is what preserves the link between a bug and the screenshot somebody took of
 * it. It cannot fetch the bytes: they live on the old GoDaddy host, reachable
 * only over FTP, and the database never recorded which directory they are in —
 * `doc_loc_server` is empty on all 250 rows and the filenames are bare
 * ("1434206420Screenshot_2015-06-13-20-00-13.png"). The directory layout
 * existed only in the old PHP.
 *
 * So the two halves are split. The migration writes FileObject rows with
 * `driver: 'legacy'` and `isComplete: false` — the platform's own way of
 * saying "this row is a pointer until the bytes are verified in place". This
 * script is what puts them in place.
 *
 * ── MATCHING IS BY FILENAME, NOT BY PATH
 *
 * Whatever directory the files come out of, the name is the only thing both
 * sides share, so the local tree is indexed by basename. A name appearing in
 * more than one directory is reported rather than guessed at: picking one of
 * two files with the same name is how a screenshot ends up attached to the
 * wrong defect.
 *
 * ── SAFE TO RE-RUN
 *
 * Only rows still marked incomplete are considered, so a second run picks up
 * exactly what the first could not find — which is the normal case, because
 * the files usually arrive in more than one batch.
 *
 *   LEGACY_FILE_ROOT=/home/ubuntu/legacy-files npm run migration:sync-files
 *   … add --dry-run to report what would happen and write nothing.
 */

const prisma = new PrismaClient()

interface Totals {
  considered: number
  uploaded: number
  missing: number
  ambiguous: number
  failed: number
}

/** Every file under `root`, indexed by lowercased basename. */
async function indexFiles(root: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>()

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const key = entry.name.toLowerCase()
      const existing = index.get(key)
      if (existing) existing.push(full)
      else index.set(key, [full])
    }
  }

  await walk(root)
  return index
}

async function main(): Promise<void> {
  const root = process.env.LEGACY_FILE_ROOT
  if (!root) {
    throw new Error(
      'LEGACY_FILE_ROOT is not set — point it at the directory the FTP pull landed in.',
    )
  }
  const bucket = process.env.S3_BUCKET
  if (!bucket) throw new Error('S3_BUCKET is not set.')

  const dryRun = process.argv.includes('--dry-run')

  console.log(`\nLegacy file sync${dryRun ? ' — DRY RUN, nothing will be written' : ''}`)
  console.log(`  source : ${root}`)
  console.log(`  bucket : ${bucket}\n`)

  const index = await indexFiles(root)
  console.log(`  indexed ${index.size} distinct filenames on disk`)

  const pending = await prisma.fileObject.findMany({
    where: { driver: 'legacy', isComplete: false },
    select: { id: true, storageKey: true, originalName: true, mimeType: true },
  })
  console.log(`  ${pending.length} file rows are still waiting for their bytes\n`)

  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' })
  const totals: Totals = {
    considered: pending.length,
    uploaded: 0,
    missing: 0,
    ambiguous: 0,
    failed: 0,
  }
  const unresolved: string[] = ['"file_id","original_name","reason"']

  for (const file of pending) {
    const matches = index.get(file.originalName.toLowerCase()) ?? []

    if (matches.length === 0) {
      totals.missing += 1
      unresolved.push(`"${file.id}","${file.originalName}","not found under LEGACY_FILE_ROOT"`)
      continue
    }
    if (matches.length > 1) {
      totals.ambiguous += 1
      unresolved.push(
        `"${file.id}","${file.originalName}","${matches.length} files share this name; not guessed"`,
      )
      continue
    }

    const source = matches[0]!
    try {
      const info = await stat(source)
      if (!dryRun) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: file.storageKey,
            Body: createReadStream(source),
            ContentType: file.mimeType,
            ContentLength: info.size,
          }),
        )
        /*
          Flipped to the real driver only after the object is in the bucket, so
          an interrupted run leaves the row exactly as it was — still legacy,
          still incomplete, still picked up next time.
        */
        await prisma.fileObject.update({
          where: { id: file.id },
          data: { driver: 's3', isComplete: true, sizeBytes: info.size },
        })
      }
      totals.uploaded += 1
      if (totals.uploaded % 500 === 0) console.log(`  … ${totals.uploaded} uploaded`)
    } catch (error) {
      totals.failed += 1
      const message = error instanceof Error ? error.message.replace(/"/g, "'") : String(error)
      unresolved.push(`"${file.id}","${file.originalName}","upload failed: ${message}"`)
    }
  }

  console.log('\n  uploaded  :', totals.uploaded)
  console.log('  missing   :', totals.missing)
  console.log('  ambiguous :', totals.ambiguous)
  console.log('  failed    :', totals.failed)

  if (unresolved.length > 1) {
    const { writeFile } = await import('node:fs/promises')
    const out = path.join(
      process.env.MIGRATION_REPORT_DIR ?? 'migration-report',
      'unsynced-files.csv',
    )
    /*
      Byte-order mark written as an escape, not a literal, matching
      `report/reporter.ts`. A raw BOM is invisible in the source and lint
      refuses it; Excel needs it to read the file as UTF-8.
    */
    const bom = String.fromCharCode(0xfeff)
    await writeFile(out, `${bom}${unresolved.join('\n')}\n`, 'utf8')
    console.log(`\n  ${unresolved.length - 1} rows could not be synced — see ${out}`)
  }
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })

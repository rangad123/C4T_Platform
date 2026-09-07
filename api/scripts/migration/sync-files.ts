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
  thumbnails: number
  missing: number
  ambiguous: number
  failed: number
}

interface Located {
  path: string
  /** Under a `thumb/` directory — a derived copy, not the original upload. */
  isThumbnail: boolean
}

/**
 * Every file under `root`, indexed by lowercased basename.
 *
 * Thumbnails are indexed but marked. The legacy host keeps a `thumb/`
 * directory beside the screenshots, and for 2,038 attachments the thumbnail is
 * the ONLY copy that survives — the full-size original was pruned years ago.
 * A thumbnail is the right image at the wrong size, which is worth having for
 * a defect from 2018 whose original is gone for good, but it must not pass
 * silently as the original. The caller prefers full-size, falls back to a
 * thumbnail, and says so on the attachment when it does.
 */
async function indexFiles(root: string): Promise<Map<string, Located[]>> {
  const index = new Map<string, Located[]>()

  async function walk(dir: string, underThumb: boolean): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, underThumb || entry.name.toLowerCase() === 'thumb')
        continue
      }
      if (!entry.isFile()) continue
      const key = entry.name.toLowerCase()
      const found: Located = { path: full, isThumbnail: underThumb }
      const existing = index.get(key)
      if (existing) existing.push(found)
      else index.set(key, [found])
    }
  }

  await walk(root, false)
  return index
}

/**
 * Picks the one file to upload for a name, or explains why it cannot.
 *
 * Full-size wins over a thumbnail every time. Two files of the same kind and
 * name are left alone rather than guessed between — choosing wrongly attaches
 * somebody else's screenshot to a defect, which is worse than not attaching
 * one at all.
 */
function chooseFile(matches: Located[]): { file: Located | null; reason?: string } {
  if (matches.length === 0) return { file: null, reason: 'not found under LEGACY_FILE_ROOT' }

  const fullSize = matches.filter((m) => !m.isThumbnail)
  if (fullSize.length === 1) return { file: fullSize[0]! }
  if (fullSize.length > 1) {
    return { file: null, reason: `${fullSize.length} files share this name; not guessed` }
  }

  const thumbs = matches.filter((m) => m.isThumbnail)
  if (thumbs.length === 1) return { file: thumbs[0]! }
  return { file: null, reason: `${thumbs.length} thumbnails share this name; not guessed` }
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
    thumbnails: 0,
    missing: 0,
    ambiguous: 0,
    failed: 0,
  }
  const unresolved: string[] = ['"file_id","original_name","reason"']

  for (const file of pending) {
    const matches = index.get(file.originalName.toLowerCase()) ?? []
    const chosen = chooseFile(matches)

    if (!chosen.file) {
      if (chosen.reason?.includes('not found')) totals.missing += 1
      else totals.ambiguous += 1
      unresolved.push(`"${file.id}","${file.originalName}","${chosen.reason ?? 'unresolved'}"`)
      continue
    }

    const source = chosen.file.path
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

        /*
          A thumbnail says so on the attachment itself. Anyone looking at a
          low-resolution screenshot deserves to know it is not the original
          rather than assume the tester uploaded something blurry.
        */
        if (chosen.file.isThumbnail) {
          await prisma.bugAttachment.updateMany({
            where: { fileId: file.id },
            data: {
              caption: 'Thumbnail — the full-size original is no longer on the legacy host.',
            },
          })
        }
      }
      if (chosen.file.isThumbnail) totals.thumbnails += 1
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

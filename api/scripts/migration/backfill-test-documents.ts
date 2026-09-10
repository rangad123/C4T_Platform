import { FileScope, PrismaClient } from '@prisma/client'
import { guessLegacyMime } from './load/context.js'
import { closeLegacyPool, query } from './legacy/client.js'

/**
 * Attaches each build's test document to the build already in the database.
 *
 * ── WHY IT WAS BLANK
 *
 * A legacy build names its test document through `builds.doc_id`, and the
 * filename lives on the `documents` row it points at. Nothing read the column,
 * so `Build.testDocumentFileId` was null on all 789 migrated builds and every
 * portal showed a blank where the document should be. 111 of 785 legacy builds
 * carry one; 45 of those still have their bytes on the old host, and the rest
 * will read "no longer available", which is at least true.
 *
 * `load/projects.ts` now does this during a normal run. This exists for the
 * rows already in the database.
 *
 * ── WHY NOT `--only=builds`
 *
 * That is the designed path and it works, but it upserts every column of every
 * build from the legacy row — name, status, dates, targets, instructions. On a
 * database people are actively testing against, that silently reverts anything
 * they have changed. This writes one column and creates the FileObject behind
 * it, and skips any build that already has a document.
 *
 * The storage key must match what `load/context.ts` builds, or `sync-files`
 * will upload the bytes to a key nothing points at:
 *
 *   legacy/test-documents/<build_id>/doc_id/<filename>
 *
 * Run `migration:sync-files` afterwards to fetch the bytes.
 *
 *   npm run migration:backfill-test-documents -- --dry-run
 *   npm run migration:backfill-test-documents
 */

const prisma = new PrismaClient()

interface LegacyRow {
  build_id: number | string
  build_add_by: number | string | null
  doc_id: number | string | null
  doc_filename: string | null
}

/**
 * The new record for a legacy row.
 *
 * `Build` carries no `legacyId` column — the migration keeps that mapping in
 * `migration_record_map` — so a build has to be looked up through it.
 */
async function migrated(
  legacyTable: string,
  legacyId: string,
  targetModel: string,
): Promise<string | null> {
  const row = await prisma.migrationRecordMap.findUnique({
    where: { legacyTable_legacyId_targetModel: { legacyTable, legacyId, targetModel } },
    select: { targetId: true },
  })
  return row?.targetId ?? null
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\nTest document backfill${dryRun ? ' — DRY RUN, nothing will be written' : ''}\n`)

  const rows = await query<LegacyRow>(
    'SELECT b.`build_id`, b.`build_add_by`, b.`doc_id`, d.`doc_filename` ' +
      'FROM `builds` b JOIN `documents` d ON d.`doc_id` = b.`doc_id` ' +
      'WHERE b.`doc_id` IS NOT NULL AND b.`doc_id` <> 0',
  )
  console.log(`  ${rows.length} legacy builds name a document that exists`)

  let attached = 0
  let alreadyHad = 0
  let noBuild = 0
  let noFilename = 0

  for (const row of rows) {
    const filename = row.doc_filename?.trim()
    if (!filename || filename === '0') {
      noFilename += 1
      continue
    }

    const legacyId = String(row.build_id)
    const buildId = await migrated('builds', legacyId, 'Build')
    if (!buildId) {
      noBuild += 1
      continue
    }
    const build = await prisma.build.findUnique({
      where: { id: buildId },
      select: {
        id: true,
        testDocumentFileId: true,
        createdAt: true,
        project: { select: { createdById: true } },
      },
    })
    if (!build) {
      noBuild += 1
      continue
    }
    if (build.testDocumentFileId) {
      alreadyHad += 1
      continue
    }

    /*
      Whoever added the build owns its document. `Build` has no creator column
      of its own, so an unmigrated uploader falls back to the project's
      creator — the nearest true attribution available.
    */
    const uploadedById =
      (row.build_add_by ? await migrated('users', String(row.build_add_by), 'User') : null) ??
      build.project.createdById

    if (!dryRun) {
      const storageKey = `legacy/test-documents/${legacyId}/doc_id/${filename}`
      /*
        Idempotent on the key, so a second run after a partial one reuses the
        row it already made rather than colliding on the unique index.
      */
      const existing = await prisma.fileObject.findFirst({
        where: { storageKey },
        select: { id: true },
      })
      const file =
        existing ??
        (await prisma.fileObject.create({
          data: {
            scope: FileScope.PROJECT_MATERIAL,
            storageKey,
            driver: 'legacy',
            originalName: filename,
            mimeType: guessLegacyMime(filename),
            sizeBytes: 0,
            uploadedById,
            isComplete: false,
            createdAt: build.createdAt,
          },
          select: { id: true },
        }))
      await prisma.build.update({
        where: { id: build.id },
        data: { testDocumentFileId: file.id },
      })
    }
    attached += 1
  }

  console.log(`\n  ${dryRun ? 'would attach' : 'attached'}   : ${attached}`)
  console.log('  already had  :', alreadyHad)
  console.log('  build missing:', noBuild)
  console.log('  no filename  :', noFilename)
  if (attached > 0) {
    console.log('\n  Now run `npm run migration:sync-files` to upload the bytes that survive.')
  }
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
    void closeLegacyPool()
  })

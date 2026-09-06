import { BroadcastStatus, DeviceType, FileScope, OsKind } from '@prisma/client'
import { query } from '../legacy/client.js'
import { DEVICE_TYPE } from '../mapping/lookups.js'
import {
  asText,
  enumValue,
  legacyRef,
  requiredText,
  text,
  timestampOr,
} from '../transform/values.js'
import type { Loader, RowOutcome } from './context.js'

/**
 * Catalog rows that only exist in the live database, plus tester assets,
 * documents and broadcasts.
 *
 * ── WHY SOME CATALOG TABLES HAVE LOADERS AND OTHERS DO NOT
 *
 * `prisma/seed-catalog.ts` already imports the eleven CSVs in
 * `api/old sql/DataCSV/` — skills, browsers, OS versions, brands and so on —
 * with idempotent upserts on natural keys. Re-implementing those here would be
 * a second source for the same rows, which is exactly what the platform rules
 * forbid, so those tables are intentionally left to the seed.
 *
 * The four below were NOT exported to CSV (`browser_versions`,
 * `mobile_os_type`, `mobile_os_version`, `network_providers`) and exist only
 * in the live MariaDB, so they need a reader of their own.
 */

// ── mobile_os_type → OperatingSystem (kind = MOBILE) ─────────────────────────

export const mobileOsLoader: Loader = {
  table: 'mobile_os_type',
  target: 'OperatingSystem',

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.ost_id)
    const name = text(row.ost_name)
    if (!name) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'OS has no name.' }
    }

    const existing = await tx.operatingSystem.findUnique({
      where: { name_kind: { name, kind: OsKind.MOBILE } },
      select: { id: true },
    })

    const os =
      existing ??
      (await tx.operatingSystem.create({
        data: { name, kind: OsKind.MOBILE },
        select: { id: true },
      }))

    await ctx.idMap.remember(tx, 'mobile_os_type', legacyId, 'OperatingSystem', os.id)
    return { kind: 'written', created: !existing }
  },
}

// ── mobile_os_version → OsVersion ────────────────────────────────────────────

export const mobileOsVersionLoader: Loader = {
  table: 'mobile_os_version',
  target: 'OsVersion',
  dependsOn: [{ table: 'mobile_os_type', model: 'OperatingSystem' }],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.mov_id)
    const version = text(row.mov_name)
    if (!version) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Version is empty.' }
    }

    const operatingSystemId = await ctx.idMap.resolve(
      'mobile_os_type',
      legacyRef(row.mov_ost_id ?? row.ost_id),
      'OperatingSystem',
    )
    if (!operatingSystemId) {
      ctx.reporter.orphan({
        legacyTable: 'mobile_os_version',
        legacyId,
        field: 'ost_id',
        referencedTable: 'mobile_os_type',
        referencedId: asText(row.mov_ost_id ?? row.ost_id),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Version has no migrated OS.' }
    }

    const existing = await tx.osVersion.findUnique({
      where: { operatingSystemId_version: { operatingSystemId, version } },
      select: { id: true },
    })

    const record =
      existing ??
      (await tx.osVersion.create({ data: { operatingSystemId, version }, select: { id: true } }))

    await ctx.idMap.remember(tx, 'mobile_os_version', legacyId, 'OsVersion', record.id)
    return { kind: 'written', created: !existing }
  },
}

// ── browser_versions → BrowserVersion ────────────────────────────────────────

/** Browser name by legacy id, so a version can find its parent. */
const browserNames = new Map<string, string>()

export const browserVersionLoader: Loader = {
  table: 'browser_versions',
  target: 'BrowserVersion',

  async prepare() {
    browserNames.clear()
    try {
      const rows = await query<Record<string, unknown>>('SELECT brw_id, brw_name FROM `browsers`')
      for (const r of rows) {
        const name = text(r.brw_name)
        if (name) browserNames.set(String(r.brw_id), name)
      }
    } catch {
      // Reported per row as an orphan.
    }
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.version_id)
    const version = text(row.version ?? row.brw_version)
    if (!version) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Version is empty.' }
    }

    /*
      Browsers were seeded from DataCSV by name, not by legacy id, so the
      parent is resolved by name here rather than through the id map. That is
      the one place in this pipeline where a name lookup is correct: the seed
      is the authority for browser rows, and it never recorded legacy ids.
    */
    const brwId = legacyRef(row.brw_id)
    const name = brwId ? browserNames.get(brwId) : null
    const browser = name
      ? await tx.browser.findFirst({ where: { name }, select: { id: true } })
      : null

    if (!browser) {
      ctx.reporter.orphan({
        legacyTable: 'browser_versions',
        legacyId,
        field: 'brw_id',
        referencedTable: 'browsers',
        referencedId: asText(row.brw_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Parent browser is not in the catalog; run the catalog seed first.',
      }
    }

    const existing = await tx.browserVersion.findUnique({
      where: { browserId_version: { browserId: browser.id, version } },
      select: { id: true },
    })

    const record =
      existing ??
      (await tx.browserVersion.create({
        data: { browserId: browser.id, version },
        select: { id: true },
      }))

    await ctx.idMap.remember(tx, 'browser_versions', legacyId, 'BrowserVersion', record.id)
    return { kind: 'written', created: !existing }
  },
}

// ── network_providers → NetworkProvider ──────────────────────────────────────

export const networkProviderLoader: Loader = {
  table: 'network_providers',
  target: 'NetworkProvider',

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.network_id)
    const name = text(row.network_name)
    if (!name) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Carrier has no name.' }
    }

    const countryCode = text(row.network_country)?.toUpperCase().slice(0, 2) ?? null

    const existing = await tx.networkProvider.findUnique({
      where: { name_countryCode: { name, countryCode: countryCode ?? '' } },
      select: { id: true },
    })

    const record =
      existing ??
      (await tx.networkProvider.create({ data: { name, countryCode }, select: { id: true } }))

    await ctx.idMap.remember(tx, 'network_providers', legacyId, 'NetworkProvider', record.id)
    return { kind: 'written', created: !existing }
  },
}

// ── devices → TesterDevice ───────────────────────────────────────────────────

/**
 * A tester's own handset.
 *
 * The legacy free-text values are kept alongside the catalog foreign keys
 * rather than replaced by them: an unrecognised handset must still display, and
 * rewriting "SM-S921B" to whichever catalog row looked closest would be a
 * guess presented as a fact. The catalog link is a bonus, not a precondition.
 */
export const testerDeviceLoader: Loader = {
  table: 'devices',
  target: 'TesterDevice',
  dependsOn: [{ table: 'users', model: 'TesterProfile' }],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.dvc_id)

    const testerProfileId = await ctx.idMap.resolve(
      'users',
      legacyRef(row.dvc_add_by ?? row.dvc_user_id),
      'TesterProfile',
    )
    if (!testerProfileId) {
      ctx.reporter.orphan({
        legacyTable: 'devices',
        legacyId,
        field: 'dvc_add_by',
        referencedTable: 'users',
        referencedId: asText(row.dvc_add_by ?? row.dvc_user_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Device has no migrated tester profile.',
      }
    }

    const model = text(row.dvc_name)
    if (!model) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Device has no model name.' }
    }

    // Soft-deleted in the legacy system stays deleted.
    if (text(row.dvc_deleted_date)) {
      return {
        kind: 'skipped',
        code: 'LEGACY_DELETED',
        message: 'Device was deleted in the legacy platform.',
      }
    }

    const type = enumValue(row.dvc_type ?? 'mobile', DEVICE_TYPE, DeviceType.MOBILE, 'dvc_type')

    const primaryNetworkId = await ctx.idMap.resolve(
      'network_providers',
      legacyRef(row.dvc_primary_network),
      'NetworkProvider',
    )
    const secondaryNetworkId = await ctx.idMap.resolve(
      'network_providers',
      legacyRef(row.dvc_secondary_network),
      'NetworkProvider',
    )
    const osVersionRefId = await ctx.idMap.resolve(
      'mobile_os_version',
      legacyRef(row.dvc_mob_os_ver_id),
      'OsVersion',
    )

    const createdAt = timestampOr(row.dvc_add_date)
    const data = {
      type: type.value,
      manufacturer: text(row.dvc_manufacturer_name ?? row.dvc_manufacturer),
      model,
      osName: text(row.dvc_os_details),
      screenSize: text(row.dvc_screen),
      ramGb: text(row.dvc_ram),
      primaryNetworkId,
      secondaryNetworkId,
      osVersionRefId,
      createdAt,
    }

    const mapped = await ctx.idMap.resolve('devices', legacyId, 'TesterDevice')
    const existing = mapped
      ? await tx.testerDevice.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const device = existing
      ? await tx.testerDevice.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.testerDevice.create({ data: { ...data, testerProfileId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'devices', legacyId, 'TesterDevice', device.id)
    return { kind: 'written', created: !existing }
  },
}

// ── user_browsers → TesterBrowser ────────────────────────────────────────────

export const testerBrowserLoader: Loader = {
  table: 'user_browsers',
  target: 'TesterBrowser',
  dependsOn: [
    { table: 'users', model: 'TesterProfile' },
    { table: 'browser_versions', model: 'BrowserVersion' },
  ],

  async prepare() {
    if (browserNames.size > 0) return
    try {
      const rows = await query<Record<string, unknown>>('SELECT brw_id, brw_name FROM `browsers`')
      for (const r of rows) {
        const name = text(r.brw_name)
        if (name) browserNames.set(String(r.brw_id), name)
      }
    } catch {
      // Reported per row.
    }
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.user_browsers_id)

    const testerProfileId = await ctx.idMap.resolve(
      'users',
      legacyRef(row.user_id ?? row.ub_user_id),
      'TesterProfile',
    )
    if (!testerProfileId) {
      ctx.reporter.orphan({
        legacyTable: 'user_browsers',
        legacyId,
        field: 'user_id',
        referencedTable: 'users',
        referencedId: asText(row.user_id),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'No migrated tester profile.' }
    }

    const brwId = legacyRef(row.browser_id ?? row.brw_id)
    const name = brwId ? browserNames.get(brwId) : null
    const browser = name
      ? await tx.browser.findFirst({ where: { name }, select: { id: true } })
      : null
    if (!browser) {
      ctx.reporter.orphan({
        legacyTable: 'user_browsers',
        legacyId,
        field: 'browser_id',
        referencedTable: 'browsers',
        referencedId: String(brwId ?? ''),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Browser not in the catalog.' }
    }

    const browserVersionId = await ctx.idMap.resolve(
      'browser_versions',
      legacyRef(row.browser_version_id ?? row.version_id),
      'BrowserVersion',
    )

    /*
      The unique key includes browserVersionId, which is nullable — and in
      Postgres two NULLs are distinct, so `findUnique` on the compound key
      cannot match a row whose version is null. `findFirst` with an explicit
      null is what actually finds it.
    */
    const existing = await tx.testerBrowser.findFirst({
      where: { testerProfileId, browserId: browser.id, browserVersionId },
      select: { id: true },
    })

    const record =
      existing ??
      (await tx.testerBrowser.create({
        data: {
          testerProfileId,
          browserId: browser.id,
          browserVersionId,
          createdAt: timestampOr(row.created_date),
        },
        select: { id: true },
      }))

    await ctx.idMap.remember(tx, 'user_browsers', legacyId, 'TesterBrowser', record.id)
    return { kind: 'written', created: !existing }
  },
}

// ── documents / build_reports → ProjectMaterial + FileObject ─────────────────

/**
 * Both legacy tables are build-scoped file uploads, and both land on
 * ProjectMaterial — the new platform's model for exactly that. Shared factory
 * because the only differences are the column names.
 */
function materialLoader(config: {
  table: string
  pk: string
  titleCol: string
  fileCol: string
  locCol: string
  buildCol: string
  projectCol?: string
  authorCol: string
  dateCol: string
}): Loader {
  return {
    table: config.table,
    target: 'ProjectMaterial',
    dependsOn: [
      { table: 'builds', model: 'Build' },
      { table: 'projects', model: 'Project' },
      { table: 'users', model: 'User' },
    ],

    async row(ctx, tx, row): Promise<RowOutcome> {
      const legacyId = String(row[config.pk])

      const filename = text(row[config.fileCol])
      if (!filename) {
        return { kind: 'skipped', code: 'MISSING_FILE', message: 'No filename recorded.' }
      }

      let buildId = await ctx.idMap.resolve('builds', legacyRef(row[config.buildCol]), 'Build')
      const projectLegacy = config.projectCol ? legacyRef(row[config.projectCol]) : null

      // A document attached only to a project goes to that project's default
      // build, which is where project-level data lives in the new model.
      if (!buildId && projectLegacy) {
        buildId = await ctx.idMap.resolve('projects', `project:${projectLegacy}:default`, 'Build')
      }
      if (!buildId) {
        ctx.reporter.orphan({
          legacyTable: config.table,
          legacyId,
          field: config.buildCol,
          referencedTable: 'builds',
          referencedId: asText(row[config.buildCol]),
        })
        return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'No build to attach to.' }
      }

      const build = await tx.build.findUnique({
        where: { id: buildId },
        select: { projectId: true },
      })
      if (!build) {
        return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Build vanished mid-run.' }
      }

      const uploadedById = await ctx.idMap.resolve(
        'users',
        legacyRef(row[config.authorCol]),
        'User',
      )
      if (!uploadedById) {
        return {
          kind: 'skipped',
          code: 'ORPHAN_REFERENCE',
          message: 'Uploader not migrated; FileObject.uploadedById is required.',
        }
      }

      if (!process.env.LEGACY_FILE_ROOT) {
        ctx.reporter.missingFile({
          legacyTable: config.table,
          legacyId,
          field: config.locCol,
          path: [text(row[config.locCol]), filename].filter(Boolean).join('/'),
          reason: 'LEGACY_FILE_ROOT not configured; file migration skipped.',
        })
        return {
          kind: 'skipped',
          code: 'FILE_NOT_MIGRATED',
          message: 'LEGACY_FILE_ROOT is unset, so the bytes cannot be located.',
        }
      }

      const createdAt = timestampOr(row[config.dateCol])
      const mappedFile = await ctx.idMap.resolve(config.table, legacyId, 'FileObject')

      const file =
        (mappedFile
          ? await tx.fileObject.findUnique({ where: { id: mappedFile }, select: { id: true } })
          : null) ??
        (await tx.fileObject.create({
          data: {
            scope: FileScope.PROJECT_MATERIAL,
            storageKey: `legacy/${config.table}/${legacyId}/${filename}`,
            driver: 'legacy',
            originalName: filename,
            mimeType: 'application/octet-stream',
            sizeBytes: 0,
            uploadedById,
            isComplete: false,
            createdAt,
          },
          select: { id: true },
        }))

      await ctx.idMap.remember(tx, config.table, legacyId, 'FileObject', file.id)

      const mapped = await ctx.idMap.resolve(config.table, legacyId, 'ProjectMaterial')
      const existing = mapped
        ? await tx.projectMaterial.findUnique({ where: { id: mapped }, select: { id: true } })
        : null

      const material =
        existing ??
        (await tx.projectMaterial.create({
          data: {
            projectId: build.projectId,
            buildId,
            title: requiredText(row[config.titleCol], filename),
            fileId: file.id,
            createdAt,
          },
          select: { id: true },
        }))

      await ctx.idMap.remember(tx, config.table, legacyId, 'ProjectMaterial', material.id)

      ctx.reporter.missingFile({
        legacyTable: config.table,
        legacyId,
        field: config.locCol,
        path: [text(row[config.locCol]), filename].filter(Boolean).join('/'),
        reason: 'FileObject created as incomplete — copy the bytes and mark isComplete.',
      })

      return { kind: 'written', created: !existing }
    },
  }
}

export const documentLoader = materialLoader({
  table: 'documents',
  pk: 'doc_id',
  titleCol: 'doc_title',
  fileCol: 'doc_filename',
  locCol: 'doc_loc_server',
  buildCol: 'doc_build_id',
  projectCol: 'doc_project_id',
  authorCol: 'doc_created_by',
  dateCol: 'doc_created_date',
})

export const buildReportLoader = materialLoader({
  table: 'build_reports',
  pk: 'brep_id',
  titleCol: 'brep_file_name',
  fileCol: 'brep_file_name',
  locCol: 'brep_file_name',
  buildCol: 'brep_build_id',
  authorCol: 'brep_user_id',
  dateCol: 'brep_time',
})

// ── message / message_recipient → Broadcast / BroadcastRecipient ─────────────

/**
 * One author, many recipients, no reply — that is `Broadcast`, not
 * `Thread`/`Message`, which models a two-way conversation. Mapping these onto
 * threads would imply discussions that never took place.
 */
export const broadcastLoader: Loader = {
  table: 'message',
  target: 'Broadcast',
  dependsOn: [{ table: 'users', model: 'User' }],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.id)

    const body = text(row.message_body)
    if (!body) {
      return { kind: 'skipped', code: 'EMPTY_BODY', message: 'Message body is empty.' }
    }
    if (text(row.deleted_at)) {
      return { kind: 'skipped', code: 'LEGACY_DELETED', message: 'Message was deleted.' }
    }

    const senderId = await ctx.idMap.resolve('users', legacyRef(row.creator_id), 'User')
    if (!senderId) {
      ctx.reporter.orphan({
        legacyTable: 'message',
        legacyId,
        field: 'creator_id',
        referencedTable: 'users',
        referencedId: asText(row.creator_id),
      })
      return { kind: 'skipped', code: 'ORPHAN_REFERENCE', message: 'Sender not migrated.' }
    }

    const createdAt = timestampOr(row.create_date)
    const data = {
      body,
      status: BroadcastStatus.SENT,
      sentAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    }

    const mapped = await ctx.idMap.resolve('message', legacyId, 'Broadcast')
    const existing = mapped
      ? await tx.broadcast.findUnique({ where: { id: mapped }, select: { id: true } })
      : null

    const broadcast = existing
      ? await tx.broadcast.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.broadcast.create({ data: { ...data, senderId }, select: { id: true } })

    await ctx.idMap.remember(tx, 'message', legacyId, 'Broadcast', broadcast.id)
    return { kind: 'written', created: !existing }
  },
}

export const broadcastRecipientLoader: Loader = {
  table: 'message_recipient',
  target: 'BroadcastRecipient',
  dependsOn: [
    { table: 'message', model: 'Broadcast' },
    { table: 'users', model: 'User' },
  ],

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.id)

    const broadcastId = await ctx.idMap.resolve('message', legacyRef(row.message_id), 'Broadcast')
    const userId = await ctx.idMap.resolve('users', legacyRef(row.recipient_id), 'User')

    if (!broadcastId || !userId) {
      ctx.reporter.orphan({
        legacyTable: 'message_recipient',
        legacyId,
        field: broadcastId ? 'recipient_id' : 'message_id',
        referencedTable: broadcastId ? 'users' : 'message',
        referencedId: String(broadcastId ? row.recipient_id : row.message_id),
      })
      return {
        kind: 'skipped',
        code: 'ORPHAN_REFERENCE',
        message: 'Missing broadcast or recipient.',
      }
    }

    const existing = await tx.broadcastRecipient.findFirst({
      where: { broadcastId, userId },
      select: { id: true },
    })

    const record =
      existing ??
      (await tx.broadcastRecipient.create({ data: { broadcastId, userId }, select: { id: true } }))

    await ctx.idMap.remember(tx, 'message_recipient', legacyId, 'BroadcastRecipient', record.id)

    /*
      `is_read` has no destination: BroadcastRecipient records delivery and
      failure, not reading. Reported once for the table rather than once per
      row, which would bury the report under thousands of identical lines.
    */
    return { kind: 'written', created: !existing }
  },
}

export const assetLoaders: Loader[] = [
  mobileOsLoader,
  mobileOsVersionLoader,
  browserVersionLoader,
  networkProviderLoader,
  testerDeviceLoader,
  testerBrowserLoader,
  documentLoader,
  buildReportLoader,
  broadcastLoader,
  broadcastRecipientLoader,
]

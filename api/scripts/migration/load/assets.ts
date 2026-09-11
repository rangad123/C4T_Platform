import { BroadcastStatus, DeviceType, FileScope, OsKind } from '@prisma/client'
import { query } from '../legacy/client.js'
import { asText, legacyRef, requiredText, text, timestampOr } from '../transform/values.js'
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
      legacyRef(row.mov_type_id),
      'OperatingSystem',
    )
    if (!operatingSystemId) {
      ctx.reporter.orphan({
        legacyTable: 'mobile_os_version',
        legacyId,
        field: 'ost_id',
        referencedTable: 'mobile_os_type',
        referencedId: asText(row.mov_type_id),
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

// ── The operating system behind a tester's browser ──────────────────────────

/**
 * `user_browsers.os_id` names a row in the legacy `os_versions` table — the
 * specific OS, "Windows 10" — not the family in `os`. All 6,096 rows carry
 * one and 6,095 of them join, but nothing read the column, so every one of
 * the 5,469 migrated browsers arrived with no operating system at all. A
 * browser with no OS beside it is most of what "browser data is not coming"
 * meant.
 *
 * The catalog seed already holds these exact names — "Windows Xp",
 * "Mac os X 10.6", "Ubuntu 12.04" — so this matches by name rather than
 * inventing catalog rows.
 */
export interface LegacyOsMaps {
  /** legacy `os_versions.os_id` → its own name and the family it belongs to. */
  versions: Map<string, { name: string; familyId: string }>
  /** legacy `os.os_id` → family name, e.g. "Windows". */
  families: Map<string, string>
}

export async function loadLegacyOsMaps(): Promise<LegacyOsMaps> {
  const versions = new Map<string, { name: string; familyId: string }>()
  const families = new Map<string, string>()
  const versionRows = await query<Record<string, unknown>>(
    'SELECT os_id, os_name, os_type_id FROM `os_versions`',
  )
  for (const r of versionRows) {
    const name = text(r.os_name)
    if (name) versions.set(String(r.os_id), { name, familyId: String(r.os_type_id) })
  }
  const familyRows = await query<Record<string, unknown>>('SELECT os_id, os_name FROM `os`')
  for (const r of familyRows) {
    const name = text(r.os_name)
    if (name) families.set(String(r.os_id), name)
  }
  return { versions, families }
}

/** The minimum of a Prisma client this resolver needs — loader tx or plain client. */
interface OsCatalogReader {
  osVersion: {
    findFirst(args: unknown): Promise<{ id: string; operatingSystemId: string } | null>
  }
  operatingSystem: { findFirst(args: unknown): Promise<{ id: string } | null> }
}

/**
 * The catalog OS version and family for a legacy `user_browsers.os_id`.
 *
 * `osVersionRefId` is the source of truth when both are set — a version
 * implies exactly one OS — so the family is taken from the matched version
 * rather than resolved separately. The family lookup is only a fallback for a
 * version name the catalog does not carry.
 *
 * "Windows" exists twice in the catalog, as DESKTOP and as MOBILE, which is
 * why the version match is scoped by family name rather than trusting the
 * version string to be unique.
 */
export async function resolveBrowserOs(
  db: OsCatalogReader,
  maps: LegacyOsMaps,
  legacyOsId: string | null,
): Promise<{ osVersionRefId: string | null; operatingSystemId: string | null }> {
  const empty = { osVersionRefId: null, operatingSystemId: null }
  if (!legacyOsId) return empty

  const version = maps.versions.get(legacyOsId)
  if (!version) return empty
  const familyName = maps.families.get(version.familyId) ?? null

  const matched = await db.osVersion.findFirst({
    where: {
      version: version.name,
      ...(familyName ? { operatingSystem: { name: familyName } } : {}),
    },
    select: { id: true, operatingSystemId: true },
  })

  if (matched) {
    return { osVersionRefId: matched.id, operatingSystemId: matched.operatingSystemId }
  }

  // No such version in the catalog — name the family, which is still true.
  if (!familyName) return empty
  const family = await db.operatingSystem.findFirst({
    where: { name: familyName },
    select: { id: true },
  })
  return { osVersionRefId: null, operatingSystemId: family?.id ?? null }
}
/** Legacy mobile_brands id -> name, for devices.dvc_manufacturer. */
const brandNames = new Map<string, string>()

/** Filled by the tester-browser loader's `prepare`, read by its `row`. */
let osMaps: LegacyOsMaps | null = null

/**
 * Text that is actually text. The legacy device rows use the string "0" where
 * they mean "nothing", so `text()` alone hands back a brand called zero.
 */
function realText(value: unknown): string | null {
  const s = text(value)
  return s === null || s === '0' ? null : s
}

/**
 * The version without the family repeated in front of it.
 *
 * `OsVersion.version` holds the whole legacy `mov_name` — "Android 11.0",
 * "iOS 10.3" — so a device rendered as `osName · osVersion` would otherwise
 * read "Android · Android 11.0".
 */
export function versionWithoutFamily(version: string, family: string): string {
  const lower = version.toLowerCase()
  const prefix = family.toLowerCase()
  if (!lower.startsWith(prefix)) return version
  const rest = version.slice(family.length).trim()
  return rest.length > 0 ? rest : version
}

/**
 * `dvc_os_details` where it is actually an OS, not a date.
 *
 * The legacy column is free text and a large share of it holds the day the
 * device was added — "11-03-2015" on a Dell, "10-05-2015" on an iPhone 5s.
 * Migrated as-is, those became the device's operating system.
 */
export function osDetailsIfNotADate(value: unknown): string | null {
  const s = realText(value)
  if (!s) return null
  return /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(s.trim()) ? null : s
}

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
    const version = text(row.version)
    if (!version) {
      return { kind: 'skipped', code: 'MISSING_REQUIRED', message: 'Version is empty.' }
    }

    /*
      Browsers were seeded from DataCSV by name, not by legacy id, so the
      parent is resolved by name here rather than through the id map. That is
      the one place in this pipeline where a name lookup is correct: the seed
      is the authority for browser rows, and it never recorded legacy ids.
    */
    const brwId = legacyRef(row.browser_id)
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
        referencedId: asText(row.browser_id),
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

  async prepare() {
    brandNames.clear()
    try {
      const rows = await query<Record<string, unknown>>(
        'SELECT mbr_id, mbr_name FROM `mobile_brands`',
      )
      for (const r of rows) {
        const name = text(r.mbr_name)
        if (name) brandNames.set(String(r.mbr_id), name)
      }
    } catch {
      // Falls back to the free-text name, reported per row.
    }
  },

  async row(ctx, tx, row): Promise<RowOutcome> {
    const legacyId = String(row.dvc_id)

    const testerProfileId = await ctx.idMap.resolve(
      'users',
      legacyRef(row.dvc_add_by),
      'TesterProfile',
    )
    if (!testerProfileId) {
      ctx.reporter.orphan({
        legacyTable: 'devices',
        legacyId,
        field: 'dvc_add_by',
        referencedTable: 'users',
        referencedId: asText(row.dvc_add_by),
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

    /*
      `devices` has no type column. Every row carries a mobile OS version and a
      SIM network, so the legacy table only ever held handsets — MOBILE is the
      accurate reading, not a default standing in for missing data.
    */
    const type = DeviceType.MOBILE

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

    /*
      Resolved here rather than left to the relation, because `osName` and
      `osVersion` are what every list and filter reads — `osVersionRefId` is
      the join nobody selects.
    */
    const osRef = osVersionRefId
      ? await tx.osVersion.findUnique({
          where: { id: osVersionRefId },
          select: { version: true, operatingSystem: { select: { name: true } } },
        })
      : null
    const osFromCatalog = osRef
      ? {
          name: osRef.operatingSystem.name,
          version: versionWithoutFamily(osRef.version, osRef.operatingSystem.name),
        }
      : null

    const createdAt = timestampOr(row.dvc_add_date)
    const data = {
      type,
      /*
        `dvc_manufacturer` is an id into `mobile_brands`; `dvc_manufacturer_name`
        is free text that reads "0" on 6,584 of the 6,665 rows. Reading the name
        first with `??` therefore took the literal string "0" as the brand for
        almost every device on the platform — `??` only falls through on null,
        and "0" is not null. The id resolves for 6,633 of them (Apple 1,822,
        Samsung 1,238, Xiaomi 721), so it leads. The free-text name is kept as
        the fallback for the handful of rows carrying a real one, and "0" is
        treated as the absence it is.
      */
      manufacturer:
        brandNames.get(String(row.dvc_manufacturer)) ?? realText(row.dvc_manufacturer_name),
      model,
      /*
        The OS comes from the catalog reference, not from `dvc_os_details`.

        That column is free text and much of it holds the day the device was
        added rather than an operating system, so reading it straight gave a
        Dell Inspiron an OS of "11-03-2015" and an iPhone 5s "10-05-2015".
        `dvc_mob_os_ver_id` resolves for 5,888 of the 5,917 devices and names
        a real version — "iOS 10.3", "Android 11.0" — so it leads, and the
        free text is kept only for the rows with no reference, and only when
        it does not look like a date.
      */
      osName: osFromCatalog?.name ?? osDetailsIfNotADate(row.dvc_os_details),
      osVersion: osFromCatalog?.version ?? null,
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
    osMaps = await loadLegacyOsMaps()
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
    const os = osMaps
      ? await resolveBrowserOs(tx, osMaps, legacyRef(row.os_id))
      : { osVersionRefId: null, operatingSystemId: null }

    const existing = await tx.testerBrowser.findFirst({
      where: { testerProfileId, browserId: browser.id, browserVersionId },
      select: { id: true },
    })

    const record = existing
      ? await tx.testerBrowser.update({
          where: { id: existing.id },
          data: os,
          select: { id: true },
        })
      : await tx.testerBrowser.create({
          data: {
            testerProfileId,
            browserId: browser.id,
            browserVersionId,
            ...os,
            createdAt: timestampOr(row.created_date),
          },
          select: { id: true },
        })

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

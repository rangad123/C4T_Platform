import { query } from '../legacy/client.js'

/**
 * Turns the ids a legacy bug stores into the text the new Bug shows.
 *
 * ── THE PROBLEM
 *
 * `bugs_report.bug_device_used` and `bug_browsers_used` look like free text
 * and are not: they are ids into `devices` and `user_browsers`. Migrated
 * straight across they became the literal strings "588" and "512", so every
 * bug on the platform displayed a number where its device and browser should
 * be — 11,729 and 9,382 of them.
 *
 * Shared by the defects loader and `backfill-bug-environment`, so the two
 * cannot drift on what a device or a browser is called.
 */

export interface BrowserLabel {
  /** "Chrome 12" — the browser and, where known, the version. */
  label: string
  /**
   * The OS that browser was registered on.
   *
   * `user_browsers.os_id` names it, which is the only place a legacy bug's
   * operating system can be recovered from — `bugs_report` has no OS column
   * of its own, so `Bug.osName` was null on all 21,554 rows.
   */
  osName: string | null
}

export interface LegacyLabels {
  /** `devices.dvc_id` → "Samsung SM-N920G". */
  devices: Map<string, string>
  /** `user_browsers.user_browsers_id` → its label and OS. */
  browsers: Map<string, BrowserLabel>
}

/**
 * A legacy cell as text, where it is really text.
 *
 * Narrowed to the two types these columns actually hold rather than
 * stringifying anything: `String(someObject)` yields "[object Object]", which
 * would sail through as a device name. "0" is the legacy spelling of empty.
 */
function text(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s === '' || s === '0' ? null : s
}

/**
 * Reads every lookup a bug's environment needs, in one pass per table.
 *
 * Row-by-row joins would be 21,554 round trips to a database on another
 * continent; these five tables are a few thousand rows in total.
 */
export async function loadLegacyLabels(): Promise<LegacyLabels> {
  const devices = new Map<string, string>()
  const browsers = new Map<string, BrowserLabel>()

  // ── Devices ───────────────────────────────────────────────────────────────
  const brands = new Map<string, string>()
  for (const row of await query<Record<string, unknown>>(
    'SELECT `mbr_id`, `mbr_name` FROM `mobile_brands`',
  )) {
    const name = text(row.mbr_name)
    if (name) brands.set(String(row.mbr_id), name)
  }

  for (const row of await query<Record<string, unknown>>(
    'SELECT `dvc_id`, `dvc_manufacturer`, `dvc_manufacturer_name`, `dvc_name` FROM `devices`',
  )) {
    const model = text(row.dvc_name)
    if (!model) continue
    /*
      `dvc_manufacturer_name` reads "0" on 6,584 of 6,665 rows, so the id into
      `mobile_brands` leads and the free text is only a fallback — the same
      order `load/assets.ts` uses for the device itself.
    */
    const brand = brands.get(String(row.dvc_manufacturer)) ?? text(row.dvc_manufacturer_name)
    // "Samsung SM-N920G", but not "Sony Sony Xperia Z2" — several models
    // already carry their own brand.
    const label =
      brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${model}` : model
    devices.set(String(row.dvc_id), label)
  }

  // ── Browsers ──────────────────────────────────────────────────────────────
  const browserNames = new Map<string, string>()
  for (const row of await query<Record<string, unknown>>(
    'SELECT `brw_id`, `brw_name` FROM `browsers`',
  )) {
    const name = text(row.brw_name)
    if (name) browserNames.set(String(row.brw_id), name)
  }

  const versionNames = new Map<string, string>()
  for (const row of await query<Record<string, unknown>>(
    'SELECT `version_id`, `version` FROM `browser_versions`',
  )) {
    const version = text(row.version)
    if (version) versionNames.set(String(row.version_id), version)
  }

  const osNames = new Map<string, string>()
  for (const row of await query<Record<string, unknown>>(
    'SELECT `mov_id`, `mov_name` FROM `mobile_os_version`',
  )) {
    const name = text(row.mov_name)
    if (name) osNames.set(String(row.mov_id), name)
  }

  for (const row of await query<Record<string, unknown>>(
    'SELECT `user_browsers_id`, `browser_id`, `browser_version_id`, `browser_version`, `os_id` ' +
      'FROM `user_browsers`',
  )) {
    const name = browserNames.get(String(row.browser_id))
    if (!name) continue
    // The catalog version first; `browser_version` is the free-text column the
    // later form wrote, and it is the only version many rows have.
    const version = versionNames.get(String(row.browser_version_id)) ?? text(row.browser_version)
    browsers.set(String(row.user_browsers_id), {
      label: version ? `${name} ${version}` : name,
      osName: osNames.get(String(row.os_id)) ?? null,
    })
  }

  return { devices, browsers }
}

import 'server-only'
import { serverFetchOrNull } from '@/lib/api/server'
import { languageOptions } from '@/lib/admin/locales'

/**
 * The option lists every "what should this build be tested on" field uses.
 *
 * ── ONE SOURCE, FOUR FORMS
 *
 * Platform, language, browser and operating-system targets appear on the
 * admin and customer project forms, on both the create and the edit side.
 * Before this, `customer/projects/new` fed them from the platform catalog
 * while the two edit forms took comma-separated free text and
 * `admin/projects/new` had its own `COMMON_PLATFORMS` array. Four forms,
 * three different ideas of what a valid answer looks like.
 *
 * ── WHY THIS OFFERS CATALOG VALUES BUT DOES NOT STORE CATALOG IDS
 *
 * `Build.targetBrowsers` and friends are `String[]`, and the schema says why:
 * the device and browser CATALOG describes what a tester's kit IS, while
 * these describe what a build ASKS FOR, "and the two lists are never
 * guaranteed to line up". A build can ask for a browser nobody on the roster
 * owns yet — that is a normal thing to ask.
 *
 * So the catalog is the right source for the OPTIONS, because an admin
 * curates it and it is what the rest of the app knows about; it is not
 * automatically the right key to store. Offering the list kills the free
 * text without coupling "what we want tested" to "what we currently have".
 *
 * ── WHEN THE CATALOG IS UNREACHABLE
 *
 * `available` is false and the option lists are empty. Callers say so in the
 * field hint rather than rendering an empty picker with no explanation —
 * `customer/projects/new` already had that copy and it is worth keeping.
 */

export interface TargetOption {
  value: string
  label: string
}

export interface TargetOptions {
  platforms: readonly TargetOption[]
  languages: readonly TargetOption[]
  browsers: readonly TargetOption[]
  operatingSystems: readonly TargetOption[]
  devices: readonly TargetOption[]
  /** False when the catalog read failed — browsers and OSes will be empty. */
  available: boolean
}

interface CatalogShape {
  operatingSystems: readonly { id: string; name: string; kind: string }[]
  browsers: readonly { id: string; name: string }[]
  deviceModels: readonly { id: string; name: string; brand: { name: string } | null }[]
}

/**
 * The platforms a project can target.
 *
 * A fixed application vocabulary rather than a catalog: `Project.platformTargets`
 * is documented in the schema as `["web","android","ios"]`, and nothing in the
 * admin catalog models "a kind of platform". `admin/projects/new` carried
 * these as a private `COMMON_PLATFORMS` array used only to build a hint;
 * naming them once here is what stops a second copy appearing.
 */
const PLATFORMS: readonly TargetOption[] = [
  { value: 'web', label: 'Web' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
  { value: 'desktop', label: 'Desktop' },
]

export async function loadTargetOptions(): Promise<TargetOptions> {
  const catalog = await serverFetchOrNull<CatalogShape>('catalog')

  return {
    platforms: PLATFORMS,
    languages: languageOptions(),
    browsers: (catalog?.browsers ?? []).map((b) => ({ value: b.name, label: b.name })),
    operatingSystems: (catalog?.operatingSystems ?? []).map((os) => ({
      value: os.name,
      label: os.name,
    })),
    /* Brand-qualified, because "Galaxy S24" alone is ambiguous across brands
       and the stored value is the label a human reads back later. */
    devices: (catalog?.deviceModels ?? []).map((d) => ({
      value: d.brand ? `${d.brand.name} ${d.name}` : d.name,
      label: d.brand ? `${d.brand.name} ${d.name}` : d.name,
    })),
    available: catalog !== null,
  }
}

/**
 * The hint under a catalog-backed picker.
 *
 * Says where the values come from when the catalog answered, and says what
 * happened when it did not — an empty picker with no explanation reads as a
 * broken form rather than a service that is briefly away.
 */
export function catalogHint(available: boolean, what: string): string {
  return available
    ? `From the platform ${what} catalog.`
    : `The ${what} catalog is unavailable right now — you can set this later.`
}

/**
 * The environment lists a bug report offers: device, OS with its versions,
 * browser and network.
 *
 * Separate from `loadTargetOptions` because the question is different. A
 * build TARGET says what should be tested; this says what a bug was actually
 * seen on, so the tester's own registered kit leads and the catalog follows.
 * Reporting from a device nobody has registered yet is normal, which is why
 * the catalog is appended rather than being the only source.
 */
export interface BugEnvironmentOptions {
  devices: readonly TargetOption[]
  osGroups: readonly { value: string; label: string; children: readonly TargetOption[] }[]
  browsers: readonly TargetOption[]
  networks: readonly TargetOption[]
}

interface EnvironmentCatalog {
  operatingSystems: readonly {
    name: string
    versions: readonly { version: string }[]
  }[]
  browsers: readonly { name: string; versions: readonly { version: string }[] }[]
  deviceModels: readonly { name: string; brand: { name: string } | null }[]
  networks: readonly { name: string }[]
}

/** Own kit first, catalog behind it, no duplicates. */
function merge(mine: readonly string[], catalog: readonly string[]): readonly TargetOption[] {
  const seen = new Set<string>()
  const out: TargetOption[] = []
  for (const value of [...mine, ...catalog]) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push({ value: trimmed, label: trimmed })
  }
  return out
}

export async function loadBugEnvironmentOptions(): Promise<BugEnvironmentOptions> {
  const [catalog, myDevices, myBrowsers] = await Promise.all([
    serverFetchOrNull<EnvironmentCatalog>('catalog'),
    serverFetchOrNull<readonly { manufacturer: string | null; model: string }[]>(
      'testers/me/devices',
    ),
    serverFetchOrNull<
      readonly {
        browser: { name: string }
        browserVersion: { version: string } | null
        operatingSystem: { name: string } | null
      }[]
    >('catalog/me/browsers'),
  ])

  const ownDevices = (myDevices ?? []).map((d) =>
    [d.manufacturer, d.model].filter(Boolean).join(' ').trim(),
  )
  const catalogDevices = (catalog?.deviceModels ?? []).map((d) =>
    d.brand ? `${d.brand.name} ${d.name}` : d.name,
  )

  const ownBrowsers = (myBrowsers ?? []).map((b) =>
    [b.operatingSystem?.name, b.browser.name, b.browserVersion?.version]
      .filter(Boolean)
      .join(' · '),
  )
  const catalogBrowsers = (catalog?.browsers ?? []).flatMap((b) =>
    b.versions.length > 0 ? b.versions.map((v) => `${b.name} ${v.version}`) : [b.name],
  )

  return {
    devices: merge(ownDevices, catalogDevices),
    osGroups: (catalog?.operatingSystems ?? []).map((os) => ({
      value: os.name,
      label: os.name,
      children: os.versions.map((v) => ({ value: v.version, label: v.version })),
    })),
    browsers: merge(ownBrowsers, catalogBrowsers),
    networks: (catalog?.networks ?? []).map((n) => ({ value: n.name, label: n.name })),
  }
}

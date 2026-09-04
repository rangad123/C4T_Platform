import type { Candidate } from './types'

/**
 * What a build says it needs covered.
 *
 * Free text, and that is not a mistake to design around — `targetDevices`,
 * `targetBrowsers` and `targetOperatingSystems` are `String[]` on `Build`,
 * typed by whoever set the build up. Nothing in the API has ever validated
 * against them, so they can hold "Android", "android 14", or "Pixel / Samsung".
 */
export interface BuildTargets {
  devices: readonly string[]
  browsers: readonly string[]
  operatingSystems: readonly string[]
}

export interface CompatibilityIssue {
  kind: 'os' | 'browser' | 'device'
  message: string
}

/**
 * Whether this tester can plausibly cover the build, and what is missing.
 *
 * Matching is loose on purpose — case-insensitive substring, either
 * direction. The targets are hand-typed and the assets come from a catalog,
 * so "Windows" must match "Windows 11" and "iOS" must match "iOS 17.2".
 * Being strict here would flag every tester as incompatible and train the
 * reader to ignore the warning, which is worse than not warning at all.
 *
 * A target the build did not set is not a requirement: an empty list means
 * "no constraint", never "nothing qualifies".
 */
export function compatibilityIssues(
  candidate: Candidate,
  targets: BuildTargets,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = []

  const testerOperatingSystems = [
    ...candidate.devices.map((d) => d.osName),
    ...candidate.browsers.map((b) => b.osVersionRef?.operatingSystem.name ?? b.operatingSystem?.name),
  ].filter((v): v is string => Boolean(v))

  const testerBrowsers = candidate.browsers.map((b) => b.browser.name)
  const testerDevices = candidate.devices.map((d) =>
    [d.manufacturer, d.model, d.type].filter(Boolean).join(' '),
  )

  if (targets.operatingSystems.length > 0 && !overlaps(targets.operatingSystems, testerOperatingSystems)) {
    issues.push({
      kind: 'os',
      message: `No registered device or browser on ${list(targets.operatingSystems)}.`,
    })
  }
  if (targets.browsers.length > 0 && !overlaps(targets.browsers, testerBrowsers)) {
    issues.push({
      kind: 'browser',
      message: `No registered ${list(targets.browsers)} browser.`,
    })
  }
  if (targets.devices.length > 0 && !overlaps(targets.devices, testerDevices)) {
    issues.push({
      kind: 'device',
      message: `No registered device matching ${list(targets.devices)}.`,
    })
  }

  return issues
}

/** Devices this tester owns that suit the build, most relevant first. */
export function relevantDevices(candidate: Candidate, targets: BuildTargets) {
  if (targets.operatingSystems.length === 0) return candidate.devices
  const matching = candidate.devices.filter((d) => d.osName && matchesAny(targets.operatingSystems, d.osName))
  return matching.length > 0 ? matching : candidate.devices
}

/** Browsers this tester owns that suit the build, most relevant first. */
export function relevantBrowsers(candidate: Candidate, targets: BuildTargets) {
  if (targets.browsers.length === 0) return candidate.browsers
  const matching = candidate.browsers.filter((b) => matchesAny(targets.browsers, b.browser.name))
  return matching.length > 0 ? matching : candidate.browsers
}

export function deviceLabel(device: Candidate['devices'][number]): string {
  const name = [device.manufacturer, device.model].filter(Boolean).join(' ') || device.type
  const os = device.osName ? ` · ${device.osName}${device.osVersion ? ` ${device.osVersion}` : ''}` : ''
  return `${name}${os}`
}

export function browserLabel(browser: Candidate['browsers'][number]): string {
  const version = browser.browserVersion ? ` ${browser.browserVersion.version}` : ''
  const os = browser.osVersionRef
    ? ` · ${browser.osVersionRef.operatingSystem.name} ${browser.osVersionRef.version}`
    : browser.operatingSystem
      ? ` · ${browser.operatingSystem.name}`
      : ''
  return `${browser.browser.name}${version}${os}`
}

function overlaps(targets: readonly string[], owned: readonly string[]): boolean {
  return owned.some((value) => matchesAny(targets, value))
}

function matchesAny(targets: readonly string[], value: string): boolean {
  const needle = value.trim().toLowerCase()
  if (!needle) return false
  return targets.some((target) => {
    const hay = target.trim().toLowerCase()
    if (!hay) return false
    return hay.includes(needle) || needle.includes(hay)
  })
}

function list(values: readonly string[]): string {
  return values.slice(0, 3).join(', ') + (values.length > 3 ? '…' : '')
}

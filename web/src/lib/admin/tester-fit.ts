/**
 * Does this tester own hardware the build actually needs?
 *
 * ── WHY THIS LIVES IN `lib/` NOW
 *
 * It was written for the inline "Invite testers" panel on the admin project
 * page, and lived in that route's `constants.ts`. That panel is gone — it
 * listed the top 40 testers by rating and could not scale past them, which is
 * not an interface for a pool in the thousands. The assignment workspace
 * replaced it, and this signal is the one thing the panel had that the
 * workspace did not, so it moved here rather than being deleted with its
 * old host. `components/admin/assign` cannot import from a route folder.
 *
 * ── IT IS A HINT, NOT A GATE
 *
 * A project with no targets, or a tester who has not listed a device yet,
 * reads as `no-signal` rather than `mismatch`. Absence of evidence is not
 * evidence of unsuitability, and an admin who wants to invite that person
 * anyway is not doing anything wrong — plenty of testers register kit later.
 * So nothing here disables a row; it only labels one.
 */
export type TesterFit = 'match' | 'no-signal' | 'mismatch'

export function deviceFitsTargets(
  devices: readonly { type: string }[],
  platformTargets: readonly string[],
): TesterFit {
  if (platformTargets.length === 0 || devices.length === 0) return 'no-signal'

  const wantsMobile = platformTargets.some((t) => /android|ios|mobile/i.test(t))
  const wantsWeb = platformTargets.some((t) => /web|desktop|browser/i.test(t))
  const wantsTablet = platformTargets.some((t) => /tablet/i.test(t))

  if (!wantsMobile && !wantsWeb && !wantsTablet) return 'no-signal'

  const hasMobile = devices.some((d) => d.type === 'MOBILE')
  const hasTablet = devices.some((d) => d.type === 'TABLET')
  const hasDesktop = devices.some((d) => d.type === 'DESKTOP')

  const matches =
    (wantsMobile && hasMobile) || (wantsWeb && hasDesktop) || (wantsTablet && hasTablet)
  return matches ? 'match' : 'mismatch'
}

/** What the reader sees next to a name. `no-signal` deliberately shows nothing. */
export const FIT_LABEL: Record<TesterFit, string | null> = {
  match: 'Has a device for this build',
  mismatch: 'No device on this platform',
  'no-signal': null,
}

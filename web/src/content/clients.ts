/**
 * Companies Crowd4Test has worked with, for the homepage logo wall.
 *
 * ⚠ WRITTEN PERMISSION IS REQUIRED BEFORE THIS SHIPS.
 * ──────────────────────────────────────────────────────────────────────────
 * content.md §4.2 marks this slot "⚠ VERIFY — only display logos you have
 * written permission to use", and the asset table at §14 repeats it: "Written
 * permission for each logo. Verbal isn't enough; most MSAs require written
 * approval for marketing use." Naming a client publicly is a stronger claim
 * than showing a number, and it is the one a client's own legal team will
 * notice. `scripts/launch-check.mjs` blocks the deploy until `permission` is
 * `true` on every entry below.
 *
 * SIX OF TEN LOGOS ARE SELF-HOSTED. FOUR STILL RENDER AS WORDMARKS.
 * ──────────────────────────────────────────────────────────────────────────
 * Each `logo` below was downloaded from that company's own site and committed
 * to `public/clients/`. They are NOT hotlinked: pointing at someone else's
 * server means their bandwidth serves this page, the image breaks the day they
 * reorganise their assets, and every host would need a `remotePatterns` entry
 * in next.config.ts.
 *
 * The four without a `logo` could not be fetched — each entry says why. The
 * wall renders those as the company name set in the display face, which is a
 * legitimate treatment rather than a broken state, so the section works today
 * and upgrades silently when the missing four arrive.
 *
 * ⚠ THESE ARE OTHER COMPANIES' TRADEMARKS. Downloading a logo is a technical
 * step, not a licence. Every mark here is the property of the company it
 * belongs to, and none may be published until that company has given written
 * permission for marketing use — see the block above.
 *
 * TO ADD ONE OF THE MISSING FOUR
 * ──────────────────────────────────────────────────────────────────────────
 *  1. Get the official asset from the company's brand kit, and written sign-off.
 *  2. Save it to `public/clients/<slug>.svg` (preferred) or `.png`.
 *  3. Set `logo`, `logoWidth`, `logoHeight` and `permission: true`.
 *
 * `logoWidth`/`logoHeight` must be the asset's INTRINSIC size — next/image uses
 * them to reserve layout space, and a wrong ratio renders the mark squashed.
 * For an SVG, read the `viewBox`.
 *
 * Colour does not need normalising by hand: the wall greyscales every mark so
 * ten brand palettes coexist on one band, and lifts the filter on hover.
 */

export interface Client {
  /** Display name. Also the text fallback when `logo` is absent. */
  name: string
  /** Stable key, and the expected `public/clients/<slug>` filename. */
  slug: string
  /**
   * Root-relative path to a self-hosted logo under `public/clients/`.
   * Absent until the official asset and written permission are in hand.
   */
  logo?: string
  /** Intrinsic width of `logo`, required by next/image. */
  logoWidth?: number
  /** Intrinsic height of `logo`, required by next/image. */
  logoHeight?: number
  /** Where to source the official asset, and confirm the legal name. */
  website: string
  /** Written marketing permission on file. The launch check reads this. */
  permission: boolean
}

export const CLIENTS: readonly Client[] = [
  {
    name: 'Airmeet',
    slug: 'airmeet',
    logo: '/clients/airmeet.svg',
    logoWidth: 802,
    logoHeight: 200,
    website: 'https://www.airmeet.com',
    permission: false,
  },
  {
    // Supplied as "trusmtingsocial" — corrected against the company's own site.
    // ⚠ NO LOGO FILE. trustingsocial.com renders its wordmark as an inline
    // <svg> in the page rather than linking an asset, so there is no file to
    // fetch. Ask the company for their brand kit.
    name: 'Trusting Social',
    slug: 'trusting-social',
    website: 'https://trustingsocial.com',
    permission: false,
  },
  {
    // ⚠ NO LOGO FILE. The site is Webflow and the wordmark is not exposed as a
    // named asset in the markup. Ask the company for their brand kit.
    name: 'MentorCloud',
    slug: 'mentorcloud',
    website: 'https://www.mentorcloud.com',
    permission: false,
  },
  {
    // Supplied as "Rewrdz" — the company spells it Rewardz.
    name: 'Rewardz',
    slug: 'rewardz',
    logo: '/clients/rewardz.svg',
    logoWidth: 221,
    logoHeight: 66,
    website: 'https://rewardz.sg',
    permission: false,
  },
  {
    name: 'Exotel',
    slug: 'exotel',
    logo: '/clients/exotel.png',
    logoWidth: 120,
    logoHeight: 36,
    website: 'https://exotel.com',
    permission: false,
  },
  {
    // ⚠ NO LOGO FILE. apalya.com did not resolve when the others were fetched;
    // the domain may be parked or retired. Confirm the company is still trading
    // under this name before listing it at all.
    name: 'Apalya',
    slug: 'apalya',
    website: 'https://www.apalya.com',
    permission: false,
  },
  {
    name: 'OnMobile',
    slug: 'onmobile',
    logo: '/clients/onmobile.svg',
    logoWidth: 576,
    logoHeight: 93,
    website: 'https://www.onmobile.com',
    permission: false,
  },
  {
    // ⚠ NO LOGO FILE. jungleegames.com refused every connection attempt — very
    // likely geo-blocked or bot-filtered rather than down, since the company is
    // active. Fetch it from a browser, or ask them for the asset.
    name: 'Junglee Games',
    slug: 'junglee-games',
    website: 'https://www.jungleegames.com',
    permission: false,
  },
  {
    name: 'Ulatus',
    slug: 'ulatus',
    logo: '/clients/ulatus.png',
    logoWidth: 1200,
    logoHeight: 363,
    website: 'https://www.ulatus.com',
    permission: false,
  },
  {
    name: 'DotPe',
    slug: 'dotpe',
    logo: '/clients/dotpe.svg',
    logoWidth: 103,
    logoHeight: 26,
    website: 'https://dotpe.in',
    permission: false,
  },
] as const

/** True once every client has written permission recorded. */
export const ALL_CLIENTS_PERMITTED = CLIENTS.every((c) => c.permission)

/**
 * Every photograph on the site, in one list.
 *
 * The prototype scattered the same six Unsplash URLs across `Home.jsx`,
 * `detail.jsx` and `pages.jsx`, each copy carrying its own alt text. Collecting
 * them here means a rotted URL is one edit, and it pairs with `<SiteImage>`
 * being the only component allowed to render an image (CLAUDE.md rule 6).
 *
 * ⚠ PLACEHOLDERS. Service Agreement §5 makes sourcing real media the Client's
 * responsibility. The six `UNSPLASH` entries below are still hotlinked
 * placeholders and `next.config.ts` whitelists `images.unsplash.com` for them.
 * Before launch: swap those URLs for self-hosted assets, remove the Unsplash
 * host from next.config.ts, and delete this warning.
 *
 * Client-supplied art is self-hosted under `public/images/pages/` and referenced by
 * root-relative path. Those need no `remotePatterns` entry — `next/image` treats
 * anything under `public/` as first-party.
 *
 * ALT TEXT. Each photo has one default `alt` describing what it SHOWS. Where the
 * prototype used a different phrasing for the same image in a different context,
 * the caller passes its own — alt text describes the picture in its setting, so
 * it is a property of the use, not only of the file.
 */

export interface Photo {
  /**
   * Either a remote URL — host must be whitelisted in next.config.ts
   * `remotePatterns` — or a root-relative path to a file under `public/`, which
   * needs no whitelist entry.
   */
  src: string
  /** Default alt text: what the photograph shows. */
  alt: string
}

const UNSPLASH = 'https://images.unsplash.com'

/** Caption rendered over every placeholder. Delete with the placeholders. */
export const PLACEHOLDER_CREDIT = 'Placeholder · Unsplash licence'

export const PHOTOS = {
  deviceTesting: {
    src: `${UNSPLASH}/photo-1573164713988-8665fc963095?ixlib=rb-4.0.3`,
    alt: 'An engineer running tests on a real device',
  },
  triage: {
    src: `${UNSPLASH}/photo-1551434678-e076c223a692?ixlib=rb-4.0.3`,
    alt: 'Engineers triaging test results on screen',
  },
  scoping: {
    src: `${UNSPLASH}/photo-1522202176988-66273c2fd55f?ixlib=rb-4.0.3`,
    alt: 'A QA lead mapping a release process with the team',
  },
  hardware: {
    src: `${UNSPLASH}/photo-1581092918056-0c4c3acd3789?ixlib=rb-4.0.3`,
    alt: 'A tester validating a build on real hardware',
  },
  dashboard: {
    src: `${UNSPLASH}/photo-1551288049-bebda4e38f71?ixlib=rb-4.0.3`,
    alt: 'Release readiness metrics on a dashboard',
  },
  team: {
    src: `${UNSPLASH}/photo-1522071820081-009f0129c71c?ixlib=rb-4.0.3`,
    alt: 'A quality engineering team reviewing findings together',
  },

  /* ─── Client-supplied, self-hosted under public/images/pages/ ─────────────
   *
   * Files moved into public/images/ via the asset refactor. The leading
   * `images/` is the only Next.js surface these need — assets under public/
   * are served at the root, so the URL is `/images/pages/c4t-landing-page.jpeg`
   * in the browser and the same path in `src`.
   *
   * These are NOT Unsplash placeholders, so they are not covered by the ⚠ at
   * the top of this file, and they are deliberately kept out of PHOTO_ROTATION
   * below — adding an entry there changes the modulo cycle and reshuffles the
   * imagery on all 33 detail pages.
   */

  /**
   * The homepage hero. Client-supplied brand artwork, self-hosted.
   *
   * It replaced `public/home.mp4`, which held this slot until the still was
   * supplied. The hero's geometry did not change with it: the mask, the
   * upward nudge and the container bleed all live on `.c4t-hero-media` in
   * overrides.css and describe a rectangle, not an element type.
   *
   * 1451×1084 — a ratio of 1.339, within half a percent of the 4:3 box the
   * hero uses, so `object-fit: cover` crops almost nothing. If this art is
   * ever replaced at a materially different ratio, check the crop rather than
   * assuming it still fits.
   *
   * JPEG, NOT PNG. The first cut of this artwork was a 1.8 MB PNG; the Client
   * re-supplied it as a 438 KB JPEG, which is the right format for what is
   * effectively a rendered illustration with photographic shading. `next/image`
   * re-encodes to WebP/AVIF either way, so the saving is in the repository
   * rather than on the wire — but a quarter of the weight in git history is
   * worth having.
   *
   * NAMED IN LOWERCASE-KEBAB, AND THAT IS LOAD-BEARING. `proxy.ts`
   * canonicalises mixed-case URLs to lowercase, so an asset with capitals in
   * its name was once redirected to a filename that does not exist and 404'd.
   * The proxy now exempts anything with a file extension, so this would work
   * either way — but the convention is what stops the next person
   * rediscovering it.
   */
  heroLanding: {
    src: '/images/pages/c4t-landing-page.jpeg',
    alt: 'Crowd4Test testers and AI agents working through a release across phones, tablets and desktop browsers',
  },

  /**
   * In use: the homepage platform section, dimmed via `c4t-media-dim`.
   *
   * ⚠ IT CARRIES A VISIBLE WATERMARK — "Zach Malinowitz", bottom-right — and it
   * is LIVE on the homepage. If this is a stock comp rather than a licensed
   * copy, it needs the paid, unwatermarked version before launch: a watermark on
   * a commercial page is both a visual defect and a licensing exposure. This is
   * the one open item on this file that is visible to a visitor today.
   */
  ai: {
    src: '/images/pages/ai.jpg',
    alt: 'A sculpted head in profile, the letters AI glowing among drifting particles inside its open cranium',
  },

  /**
   * ⚠ CURRENTLY UNUSED. It held the homepage platform section until `ai` took
   * that slot. The entry and `public/images/pages/robot.jpg` (1.16 MB — the
   * largest image in the repo) are both still here; if no slot is found for it,
   * delete both rather than shipping an asset nothing points at.
   */
  robot: {
    src: '/images/pages/robot.jpg',
    alt: 'A small white robot with an LED dot-matrix face, marked Bot across its chest',
  },
} as const satisfies Record<string, Photo>

export type PhotoKey = keyof typeof PHOTOS

/**
 * The rotation `detail.jsx` walked with `DPHOTOS[index % DPHOTOS.length]`, so
 * that adjacent detail pages in a family don't open with the same picture.
 * Order is load-bearing — changing it reshuffles every detail page.
 */
const PHOTO_ROTATION: readonly PhotoKey[] = [
  'deviceTesting',
  'triage',
  'scoping',
  'hardware',
  'dashboard',
  'team',
]

/** The nth photo in the rotation, wrapping. */
export function rotatedPhoto(index: number): Photo {
  const key = PHOTO_ROTATION[index % PHOTO_ROTATION.length]
  // The modulo above cannot miss, but the index signature does not know that.
  return PHOTOS[key ?? 'deviceTesting']
}

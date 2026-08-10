/**
 * The four social marks used in the footer.
 *
 * WHY INLINED RATHER THAN <img src="/social/...">
 * ──────────────────────────────────────────────────────────────────────────
 * `<img src="…svg">` rasterises the SVG at decode time and discards the
 * `currentColor` reference — the rendered image is then a fixed-colour
 * raster that nobody can re-style. The stroke therefore stays whatever the
 * SVG file was authored with (`#000000`).
 *
 * Inlining the SVG as a React `<svg>` element keeps `currentColor` live, so
 * the parent's `color` token flows through to the stroke. Set `color: var(…)`
 * on the wrapper and the icon follows. That's how the icons end up reading as
 * near-white on the ink-950 footer band.
 *
 * These four started as files under `public/social/`. Those were deleted once
 * the markup moved in here — nothing referenced them any more, and a served
 * asset no code points at is just something for the next person to wonder about.
 * The paths are gone; this file is the only source for the glyphs.
 *
 * Each is a 24×24 Feather-style outline at 2px stroke, matching the Lucide set
 * the rest of the site uses. They are NOT from a brand-icon package: neither
 * lucide-react nor simple-icons ships a LinkedIn mark (both dropped it over
 * trademark concerns), so pulling a dependency in would have covered three of
 * the four and left the fourth to be hand-placed anyway.
 */

import type { SVGProps } from 'react'

function Linkedin(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2a2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6M2 9h4v12H2z" />
      <circle cx={4} cy={4} r={2} />
    </svg>
  )
}

function Youtube(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.5 17a24.1 24.1 0 0 1 0-10a2 2 0 0 1 1.4-1.4a49.6 49.6 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.1 24.1 0 0 1 0 10a2 2 0 0 1-1.4 1.4a49.6 49.6 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
      <path d="m10 15l5-3l-5-3z" />
    </svg>
  )
}

function Facebook(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  )
}

function Instagram(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect width={20} height={20} x={2} y={2} rx={5} ry={5} />
      <path d="M16 11.37A4 4 0 1 1 12.63 8A4 4 0 0 1 16 11.37m1.5-4.87h.01" />
    </svg>
  )
}

export const SOCIAL_ICONS = {
  linkedin: Linkedin,
  youtube: Youtube,
  facebook: Facebook,
  instagram: Instagram,
} as const

/**
 * The glyphs this site can render. `content/nav.ts` imports this as a TYPE ONLY,
 * so no runtime dependency runs from content back to components — TypeScript
 * erases the import. The payoff is that adding a profile to SOCIAL_PROFILES
 * without a matching glyph here fails the build instead of rendering a gap.
 */
export type SocialIconName = keyof typeof SOCIAL_ICONS

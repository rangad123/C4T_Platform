# Crowd4Test website — project rules

This repo implements the Crowd4Test marketing site in Next.js (App Router, TypeScript)
from the design handoff in `web/design-handoff/`. Read its `README.md`
before making structural decisions. These rules apply to every change, always.

## Hard rules

1. **No raw values in components.** Never write a hex colour, px font-size, or ad-hoc
   spacing number. Reference the semantic CSS variables from `styles/tokens/`
   (`--text-primary`, `--surface-sunken`, `--border-default`, `--space-*`, …).
   If a value you need has no token, ask before inventing one.
2. **No pure black (#000) and no pure white (#fff)** anywhere in composition. The page
   floor is `--ink-50`; the darkest surface is `--ink-950`.
3. **No Tailwind, no CSS-in-JS libraries.** Token CSS + CSS Modules only.
4. **No CMS.** Content lives in typed modules under `content/` (MDX in-repo for
   long-form posts). Do not add Sanity/Contentful/Payload or an admin UI.
5. **One `[slug]` template per family.** ai-testing, services and platform detail
   pages are generated from content with `generateStaticParams` — never hand-write
   individual page files per service.
6. **Images are remote URLs**, served through `next/image` with
   `images.remotePatterns`. Every image goes through the single `<SiteImage>` wrapper,
   with explicit dimensions and real `alt` text.
7. **Server Components by default.** `"use client"` only for TopNav, Tabs,
   FaqAccordion, the case-study carousel and ContactForm.
8. **Never suppress focus styles.** 2px solid ink outline at 2px offset on every
   interactive element, inverted to white on dark surfaces.
9. **Do not port the tweaks panel.** Density is `standard`, rhythm is dark/light
   `contrast`, accent is `teal`. These are fixed.
10. **Do not build `/industries/*` or `/solutions/*`.** The copy exists in
    `content.md` but those sections were removed from the navigation.

## Visual system (summary — full detail in the handoff README)

- **Ink ramp** `950 #17130f · 900 #241e18 · 800 #332b23 · 700 #4a423b · 600 #625950 ·
  500 #7a716a · 400 #9a928b · 300 #c9c3bc · 200 #e4dfd9 · 100 #f1ede8 · 50 #faf8f5`
- **Accent: teal** `--teal-500 #0b7a6e`, hover `#086055`, active `#05463e`.
  Applied through the semantic aliases, not by remapping the coral scale.
- **Type:** Instrument Sans (400/500/600) + JetBrains Mono (500/600) via
  `next/font/google`, exposed as `--font-sans` / `--font-mono`. Display weight is
  **600, never 700**. Body 400/1.6, 16–18px, max ~75ch.
- **Layout:** 4px grid, 1200px container, 96px sections (64px compact/mobile),
  24px card padding, 20px grid gaps.
- **Shape:** 6px controls, 10px cards, 14px panels. Hairlines
  (`1px solid var(--border-default)`) do the structural work.
- **Elevation:** `--shadow-md` on card hover and open menus only; `--shadow-lg` on the
  highlighted pricing plan and modals only. No glows, no coloured shadows.
- **Motion:** 140ms controls, 200ms surfaces, `cubic-bezier(.2,0,0,1)`. Cards lift 2px
  on hover. `prefers-reduced-motion` zeroes every duration.
- **Icons:** `lucide-react`, outline only, 2px stroke, sizes 16/20/24/32.
  **No emoji. Never hand-roll an SVG.**

## Copy rules

Sentence case everywhere (mono uppercase badges are the only exception). "We" for
Crowd4Test, "you" for the customer. Short declarative sentences. Numbers use the true
minus sign (−), `×` for multipliers, tabular figures.

CTAs are verb-first and concrete — *Book a demo*, *Scope a pilot*, *Talk to an
engineer*. Never *Learn more*, *Get started*, *Click here*.

**Banned:** exclamation marks, emoji, and the words *seamless, leverage, unlock,
empower, cutting-edge, game-changing*, and *solutions* used as a standalone noun.

Never write new marketing copy. All text comes from
`web/design-handoff/design/content.md`. Placeholders like `{{5,000+}}`
and `{{120+}}` are real values awaiting confirmation — resolve them in one content
module, do not hardcode them across pages.

## Working style

- Stop after each numbered step in the README's build order so it can be reviewed.
- When unsure how a section should look, open the matching screenshot in
  `web/design-handoff/screenshots/` and the prototype at
  `web/design-handoff/design/index.html`.
- Port design-system components from the readable sources in
  `web/design-handoff/ds_components/`. The compiled bundle that warning used to
  refer to has been deleted, along with the tweaks panel rule 9 forbids and the
  prototype's own token CSS, which `styles/tokens/` supersedes.

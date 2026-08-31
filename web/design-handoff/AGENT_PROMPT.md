# Kickoff prompt for the AI coding agent

Paste this into Claude Code (or equivalent) from the root of a fresh Next.js app, with
this handoff folder placed inside it.

---

Read `design_handoff_crowd4test_website/README.md` in full before writing any code,
then read `design/content.md` for the copy and `design/index.html` +
`design/site/*.jsx` for the layouts.

Build the Crowd4Test marketing website in this Next.js App Router + TypeScript project,
following that README. Rules:

1. **Copy `design/_ds/tokens/*.css` verbatim** into `styles/tokens/` and import them in
   `app/layout.tsx`. Never write a raw hex, px font-size, or ad-hoc spacing value in a
   component — reference the semantic CSS variables.
2. **Port the design-system components** from `design/_ds/_ds_bundle.js` into
   `components/ds/` as typed modules. Server Components by default; `"use client"`
   only for TopNav, Tabs, FaqAccordion, the carousel and ContactForm.
3. **Move all content out of the `window.*` globals** in `design/site/data.js`,
   `pagedata.js` and `detaildata.js` into typed modules under `content/`.
4. **One `[slug]` route template per family** (ai-testing, services, platform) driven
   by content — do not hand-write 33 pages. Use `generateStaticParams`.
5. Use the exact URLs, SEO titles and meta descriptions from `content.md`.
6. Replace the Lucide CSS-mask `Icon` with `lucide-react`; keep the size and colour
   rules from the README.
7. Load Instrument Sans and JetBrains Mono via `next/font/google`, exposed as
   `--font-sans` / `--font-mono`.
8. Keep the custom section patterns (`.c4t-deep`, `.c4t-airy`, `.c4t-marquee`,
   `.c4t-bento`, the carousel, the StatBlock divider padding) as co-located CSS
   Modules, matching the CSS in `design/index.html`'s `<style>` block.
9. **Do not port `tweaks-panel.jsx`.** Hardcode density `standard`, dark/light
   contrast rhythm, teal accent.
10. **No CMS.** Blog posts and case studies are typed content modules (or MDX files in
    the repo) rendered by `[slug]` routes with `generateStaticParams`. Do not add
    Sanity/Contentful/Payload or an admin UI.
11. **Images are fetched from the web**, not stored in the repo. Keep the remote
    Unsplash URLs, serve them via `next/image`, add
    `images.remotePatterns` for `images.unsplash.com` in `next.config.ts`, and put
    every image behind one `<SiteImage>` wrapper with explicit dimensions and real
    `alt` text so URLs can be swapped in one place.

Work in the order given in the README's *Suggested build order* and stop after each
numbered step so I can review.

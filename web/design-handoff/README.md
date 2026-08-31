# Handoff: Crowd4Test marketing website → Next.js

## Overview

A complete enterprise B2B marketing website for **Crowd4Test**, a digital quality
engineering partner that pairs AI test agents with a vetted global community of human
testers. The design covers a homepage plus ~50 sub-pages across five nav sections
(AI Testing, Services, Platform, Company, plus Pricing and Contact), all built on the
**Crowd4Test Design System**.

Target implementation: **Next.js (App Router) + TypeScript**.

## About the design files

Everything in `design/` is a **design reference built in HTML** — a working prototype
that shows intended look, copy, layout and behaviour. It is **not** production code to
copy verbatim. It runs entirely in the browser: React 18 UMD + in-browser Babel, with
JSX loaded as `<script type="text/babel">` and page content held in plain
`window.*` globals. None of that survives into Next.js.

The task is to **recreate these designs in a Next.js codebase** using its idioms:
Server Components by default, file-based routing, `next/font`, `next/image`, and
real TypeScript modules instead of window globals. The visual output should match
the prototype closely; the architecture should not.

## Fidelity

**High-fidelity.** Final colours, typography, spacing, radii, shadows, motion, copy
and interactions. Every value comes from design-system tokens — implement it
pixel-accurately by porting the token CSS as-is, not by re-deriving values.

---

## Architecture in the prototype vs. what to build

| Prototype | Next.js target |
|---|---|
| One `index.html`, client-side label routing (`ROUTES` map in `App.jsx`) | File-based routes under `app/`, one folder per URL |
| `window.C4TH` / `C4TP` / `C4TD` content globals | Typed content modules in `content/` (no CMS — see below) |
| `<script type="text/babel">` JSX | Compiled TS/TSX modules |
| Design system loaded as a UMD bundle on `window.Crowd4TestDesignSystem_772017` | Design-system components copied into `components/ds/` as real modules |
| Unsplash hotlinks | `next/image` with the same remote URLs (see *Assets*) |
| Tweaks panel (density / theme / accent) | **Drop it.** It is a design-exploration tool, not a site feature. Pick one setting and hardcode it (current: density `standard`, theme `contrast`, accent `teal`). |

### Recommended structure

```
app/
  layout.tsx                    TopNav + Footer + fonts + token CSS
  page.tsx                      Homepage
  ai-testing/page.tsx           hub
  ai-testing/[slug]/page.tsx    9 detail pages (generateStaticParams)
  services/page.tsx             hub
  services/[slug]/page.tsx      15 detail pages
  platform/page.tsx             hub
  platform/[slug]/page.tsx      9 detail pages
  pricing/page.tsx
  contact/page.tsx              the only page needing a server action
  company/about|careers|partners|trust|blog|case-studies/page.tsx
  not-found.tsx
components/
  ds/                           design-system primitives (see below)
  sections/                     composed page sections (Hero, Bento, Marquee, Carousel…)
content/
  nav.ts  home.ts  services.ts  platform.ts  aiTesting.ts  company.ts
  blog.ts  caseStudies.ts               posts as data, not a CMS
styles/
  tokens/*.css                  copied verbatim from design/_ds/tokens/
  globals.css
```

The three detail families are structurally identical — **one `[slug]` template per
family, driven by content**, not 33 hand-written pages. That is how the prototype does
it (`design/site/detail.jsx`) and it should stay that way.

---

## Route map

Slugs are already final in `design/content.md` (each page block starts with a
`**URL:**` line, plus its `SEO title` and `Meta description` — feed these straight
into Next's `metadata` export).

**Top level:** `/` · `/pricing` · `/contact` (or `/book-a-demo`)

**AI Testing** — `/ai-testing` hub + `/ai-testing/{genai-llm-testing, ai-agent-testing,
chatbot-testing, voice-ai-testing, rag-evaluation, red-teaming,
bias-and-fairness-testing, model-monitoring, ai-data-collection}`

**Services** — `/services` hub + `/services/{crowd-testing, functional-testing,
test-automation, mobile-app-testing, web-app-testing, api-testing, performance-testing,
security-testing, accessibility-testing, localization-testing, payment-testing,
usability-testing, compatibility-testing, game-testing, iot-and-ar-vr-testing}`

**Platform** — `/platform` hub + `/platform/{ai-test-generation, ai-exploratory-agents,
ai-bug-triage, regression-optimizer, release-readiness-score, analytics, device-cloud,
integrations, security}`

**Company** — `/company/{about, careers, partners, trust, blog, case-studies}`

`content.md` also contains copy for `/industries/*` and `/solutions/*` sections that
were removed from the navigation late in design. **Do not build them** unless the
client reinstates them; the nav has no entry point.

---

## Design tokens

Copy `design/_ds/tokens/*.css` into `styles/tokens/` **unchanged** and import them in
`app/layout.tsx`. Do not convert them to a Tailwind config by hand — if Tailwind is
required, generate the theme from these variables so there is one source of truth.

### Colour (warm near-monochrome + one accent)

Ink ramp: `--ink-950 #17130f` · `900 #241e18` · `800 #332b23` · `700 #4a423b` ·
`600 #625950` · `500 #7a716a` · `400 #9a928b` · `300 #c9c3bc` · `200 #e4dfd9` ·
`100 #f1ede8` · `50 #faf8f5`. **No pure black, no pure white** anywhere in
composition — the page floor is `--ink-50`, not white.

Accents: coral `--coral-500 #e8532f` (600 `#cc3f1d`, 700 `#a32f13`) and teal
`--teal-500 #0b7a6e` (600 `#086055`, 700 `#05463e`).
**The shipped design uses the teal accent**, applied by remapping the coral scale onto
teal (see `ACCENT_CSS.teal` in `design/site/App.jsx`). In Next.js, do this properly:
change the semantic aliases in `colors.css` (`--action-primary-bg`, `--text-brand`,
`--text-link`, `--border-brand`, `--surface-brand*`) to the teal values and delete the
remap hack.

Semantic aliases (`--text-primary`, `--surface-sunken`, `--border-default`, …) are what
components must reference. Never a raw hex in a component.

The prototype also overrides a handful of aliases at the page level to move the whole
site off white onto the warm ink floor — fold these into `colors.css` rather than
carrying a page-level override block:

```css
--surface-canvas: var(--ink-50);  --surface-raised: var(--ink-50);
--surface-sunken: var(--ink-100); --surface-inverse-raised: var(--ink-900);
--border-inverse: var(--ink-800); --text-inverse: var(--ink-50);
--text-inverse-muted: var(--ink-300); --surface-muted: var(--ink-200);
--action-inverse-bg: var(--ink-50); --action-secondary-bg: var(--ink-50);
```

### Type

**Instrument Sans** (400/500/600) for everything visible, **JetBrains Mono** (500/600)
for eyebrows, badges, metadata and table keys. Load both with `next/font/google` and
expose them as `--font-sans` / `--font-mono` so the token CSS keeps working.

Display sizes are weight **600, never 700**, tightly tracked: 72px/-2.6px,
56px/-1.8px. Body is 400 at 1.6 line-height, 16–18px, max ~75ch. Mono labels are
uppercase at 0.08–0.12em tracking, 12–13px. Full scale is in
`design/_ds/tokens/typography.css`.

### Spacing, shape, elevation, motion

4px base grid. Container **1200px**, wide shell 1360px, prose 720px. Sections 96px
vertical (64px compact / mobile). Cards 24px padded (32px tall service cards), 20px
grid gaps. Radii: 6px controls, 10px cards, 14px panels, pill/round for tags and
avatars. Hairlines (`1px solid var(--border-default)`) do most structural work.
`--shadow-md` only on card hover and open menus; `--shadow-lg` only on the highlighted
pricing plan and modals. No glows, no coloured shadows, no inner shadows.

Motion: 140ms controls, 200ms surfaces, single curve `cubic-bezier(.2,0,0,1)`. Cards
lift **2px** on hover. Nothing bounces or autoplays except the logo marquee.
`prefers-reduced-motion` must zero every duration — the prototype already does this
for the marquee.

---

## Components

### Design-system primitives (port from the design system, don't reinvent)

Core: `Button` `IconButton` `Icon` `Badge` `Tag` `Logo`
Forms: `Field` `Input` `Textarea` `Select` `Checkbox` `Radio` `Switch`
Navigation: `TopNav` `Footer` `Tabs` `Pagination` `Breadcrumb`
Marketing: `Hero` `Section` `SectionHeader` `CapabilitySection` `FeatureCard`
`ServiceCard` `IndustryCard` `ResourceCard` `CaseStudyCard` `StatBlock` `LogoCloud`
`Testimonial` `PricingTable` `FaqAccordion` `CtaBanner` `ContactForm` `Media`

Source of truth: `design/_ds/_ds_bundle.js` (compiled) — the readable per-component
JSX, prop contracts (`.d.ts`) and usage notes live in the design-system project. Port
each as a Server Component unless it needs state; only `TopNav` (mega menus),
`FaqAccordion`, `Tabs`, the case-study carousel and `ContactForm` need
`"use client"`.

`Icon` renders **Lucide** glyphs as a CSS mask so they inherit `currentColor`. In
Next.js, replace the CDN mask approach with `lucide-react` — same icon set, proper
tree-shaking, no network dependency. Rules stay: outline only, 2px stroke, sizes
16/20/24/32, `--text-secondary` by default, accent only inside feature tiles and
mega-menu rows, teal only for confirmation ticks. **No emoji. Never hand-roll an SVG.**

### Custom section patterns built for this site

These are in `design/site/` and `design/index.html`'s `<style>` block. Port the CSS
into co-located CSS Modules.

1. **`.c4t-deep` — the immersive dark section.** `background: var(--ink-950)` plus two
   pseudo-element layers: a `::before` radial glow from `--ink-800` at 60% opacity
   descending from the top edge, and a `::after` 72px grid of `--ink-900` hairlines at
   50% opacity, radially masked so it fades out downward. Children need
   `position:relative; z-index:1`. This is what makes dark sections feel premium
   rather than flat — keep both layers.
2. **`.c4t-airy` — the light counterpart.** A single soft `--ink-200` radial bloom at
   55% opacity from the top-right.
3. **`.c4t-marquee` — infinite logo/tester ribbon.** Track is `width:max-content`
   holding the set twice, animated `translateX(0 → -50%)` over 36s linear infinite,
   with a horizontal gradient mask feathering both edges and `animation-play-state:
   paused` on hover. Zeroed under `prefers-reduced-motion`.
4. **`.c4t-bento` — the problem section.** 3-column grid (`1.15fr 1fr 1fr`),
   `grid-auto-rows: minmax(210px, auto)`: tall card spans rows 1–2 in column 1 with
   content bottom-aligned, a wide card spans columns 2–3 in row 1, two equal cards
   below. Collapses to one column under 900px with all spans cleared.
5. **Case-study carousel.** Horizontal snap-scroll track, one visible card plus a peek
   of the next, prev/next controls and dot indicators.
6. **`StatBlock` divider alignment.** Stats are separated by `border-left` hairlines;
   each cell gets symmetric 32px horizontal padding with the first cell's left padding
   removed, so dividers sit optically centred between figures. Responsive rules reset
   the border on the first cell of each row. Reimplement carefully — this was a real
   defect twice.
7. **`.c4t-role-row` — careers job table.** `1.4fr 1fr 1fr auto` grid rows separated
   by hairlines, stacking to one column under 800px.

### Section rhythm (deliberate, not mechanical)

Dark and light sections alternate to create pace: Hero dark → social proof light →
stats dark → services light → platform dark → case studies light → testimonials dark
→ resources light → final CTA dark → footer dark. Dark sections use
`ink-950/900/800`; light sections `ink-50/100` with `200/300` for secondary surfaces.
Transitions are hairline edges (`.c4t-edge`, `.c4t-edge-light`) plus the glow layers —
**no bright gradients, no colours outside the token scale.**

---

## Interactions & behaviour

- **TopNav**: mega-menu dropdowns per section, opening on hover (desktop) and click
  (keyboard/touch), with `--shadow-md`. Active section is underlined. Announcement bar
  above it. Needs a proper mobile drawer — the prototype's is minimal.
- **Nav links**: `--ink-700 → --ink-950` on hover. **Text links**: accent, hover one
  step darker with a 3px-offset underline.
- **Buttons** darken on hover, deepen on press. Never lighten, never scale.
- **Cards** lift 2px + `--shadow-md` + border darken on hover. Whole card is the click
  target where it links somewhere.
- **Focus**: 2px solid ink outline at 2px offset on every interactive element, inverted
  to white on dark surfaces; inputs use a 3px soft ink ring. Never suppressed.
- **Disabled**: 55% opacity + `not-allowed`.
- **FAQ accordion**: single-open, 200ms height transition.
- **Carousel**: snap scroll, arrows disable at each end.
- **Contact form**: the only stateful form. Fields — name, work email, company, role,
  what you're testing (select), message. Validate email format and required fields on
  blur; show errors through `Field`'s error slot, never as placeholder text. Wire to a
  server action + CRM/email. Reassurance under the button, small and factual
  ("We reply within one business day."). Needs `"use client"`.
- **Responsive**: grids drop 3 → 2 → 1 and never reflow rows. Breakpoints in use:
  1100px, 900px, 800px, 640px. Touch targets ≥44px (48px primary CTAs).

## State management

Almost none — this is a fully static marketing site (`generateStaticParams` across all
three `[slug]` families plus blog and case studies). Client state exists only for:
mega-menu open state, mobile nav open state, accordion open index, carousel scroll
index, and contact-form field/validation/submit state. No global store, no client data
fetching, no runtime API beyond the contact-form server action.

## SEO & metadata

Every page block in `content.md` carries its `SEO title` and `Meta description` —
port them into per-route `metadata` exports. Add `generateMetadata` for the `[slug]`
templates, canonical URLs, OG images, and `Organization` + `Service` JSON-LD. The
site is the company's primary acquisition channel; treat metadata as content, not
boilerplate.

## Content source: no CMS

**Decided: no CMS.** All content — including blog posts and case studies — ships as
typed modules under `content/`, and the whole site builds statically. Blog posts and
case studies are arrays of typed objects (or MDX files under `content/blog/` if long-form
authoring matters), rendered by `[slug]` routes with `generateStaticParams`. Editing
content means a commit and a redeploy. Do not add Sanity/Contentful/Payload or an
admin UI.

If long-form posts are in scope, use MDX (`@next/mdx`) so posts stay files in the repo
while supporting headings, images and code blocks.

## Assets

- **Images are fetched from the web** — remote URLs, not files in the repo. The
  prototype uses Unsplash (`DPHOTOS` in `design/site/detail.jsx` and per-section
  `photo` objects in `site/Home.jsx` / `site/pages.jsx`). Keep that approach:
  serve them through `next/image` and whitelist the hosts in `next.config.ts`:

  ```ts
  images: { remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }] }
  ```

  Put every image behind one `<SiteImage>` wrapper so a URL swap is a single change.
  Always pass explicit `width`/`height` (or `fill` + a sized container) and real
  `alt` text — the prototype already has descriptive alt on every image. Note that
  hotlinked images add a third-party dependency: if a URL rots, the image 404s, so
  keep the URL list in one content module where it can be audited.
- **Licence check:** Unsplash's licence permits commercial use, but verify each photo
  individually before launch and drop the "Placeholder · Unsplash licence" captions
  once the final set is chosen. Art direction to match when picking: warm natural
  light, un-styled, people over hardware, real testers and real screens; product
  screenshots at true pixel scale, never tilted in a 3D mock.
- **Icons**: Lucide (ISC). Switch to `lucide-react`.
- **Fonts**: Instrument Sans + JetBrains Mono, Google Fonts. Both are design-system
  substitutions, not supplied brand fonts — confirm with the client.
- **Logo**: **no artwork exists.** The `Logo` component is type-only with an accent
  "4". Get real files before launch.
- **Customer names, logos, statistics, quotes and case studies are invented
  placeholders.** They must be replaced with verified figures before publication —
  the brand voice makes measurable claims, so unverified numbers are a liability.

## Content

`design/content.md` is the full authored copy for every page — the single source of
truth for text. Placeholders appear as `{{5,000+}}`, `{{120+}}`, `{{2,000+}}`,
`{{40+}}`: real values to confirm, not decoration. Resolve them in one content
module so a change propagates.

Voice rules that the implementation must not quietly break: sentence case everywhere
(mono uppercase badges excepted), "we"/"you", short declarative sentences, numbers
with the true minus sign (−) and `×` for multipliers, tabular figures on metrics.
Verb-first concrete CTAs ("Book a demo", "Scope a pilot") — never "Learn more" or
"Get started". No exclamation marks, no emoji, and none of: seamless, leverage,
unlock, empower, cutting-edge, game-changing, "solutions" as a standalone noun.

## Suggested build order

1. Scaffold Next.js + TypeScript; import token CSS; wire `next/font`.
2. Port DS core + navigation primitives; build `app/layout.tsx` with TopNav/Footer.
3. Port marketing primitives (`Section`, `SectionHeader`, `Hero`, `FeatureCard`,
   `StatBlock`, `CtaBanner`, `FaqAccordion`).
4. Move content from the `window.*` globals into typed `content/` modules.
5. Build the homepage — it exercises nearly every pattern (bento, marquee, carousel,
   stat bands, dark/light rhythm).
6. Build the three `[slug]` detail templates + their hubs from the content modules.
7. Pricing, Contact (with server action), Company pages, `not-found`.
8. Metadata, JSON-LD, sitemap, analytics.
9. Blog and case-study `[slug]` routes from the content modules (MDX if long-form).
10. Finalise image URLs, replace placeholder stats and logo; then accessibility and
    Lighthouse passes.

## Files in this bundle

```
design/
  index.html          Entry point — page-level CSS for all custom section patterns
  site/App.jsx        Routing map, tweak/density/accent CSS, layout shell
  site/Home.jsx       Homepage composition (bento, marquee, carousel, stat bands)
  site/pages.jsx      Hub + Pricing/Contact/About/Trust/Blog/CaseStudies/Careers/Partners
  site/detail.jsx     The shared detail-page template for all 33 sub-pages
  site/data.js        Nav IA, footer columns, homepage content
  site/pagedata.js    Hub and standalone page content
  site/detaildata.js  Detail-page and company-page content
  tweaks-panel.jsx    Design-exploration tool — do not port
  _ds/tokens/*.css    Design tokens — copy these verbatim
  _ds/styles.css      Token import list + global base
  _ds/_ds_bundle.js   Compiled design-system components (reference for porting)
  content.md          Full authored copy, URLs, SEO titles, meta descriptions
```

### Running the prototype locally

Serve the `design/` folder over HTTP (`npx serve design`) and open `index.html`.
It needs network access for React, Babel and the Unsplash images. Opening it via
`file://` will not work.

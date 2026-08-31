# Crowd4Test Design System

**Crowd4Test** is a digital quality engineering partner. It pairs AI test agents with a vetted global community of human testers: the agents give speed and coverage, the people give judgment and real-world context. The pitch line the brand is built around — *AI can't grade its own homework* — is also the organising idea of the design: instrumentation-flavoured mono labels, evidence-forward numbers, and a warm, human canvas underneath.

## Sources

**None.** No codebase, Figma file, logo, photography or existing site was supplied. This system was authored from the written brief:

- Product context: *"a digital quality engineering partner that pairs AI agents with a vetted global community of human testers"*
- Surface to design: a responsive enterprise B2B marketing website (17 screens, listed below)
- Direction chosen with the user: enterprise B2B SaaS, warm red/coral accent

Everything here — palette, type, components, copy — is original work for Crowd4Test. Customer names, statistics and case studies in the UI kit are **fictional placeholders**; replace them before anything ships.

> **No logo artwork exists.** The `Logo` component renders the name in the display face with a coral "4". Do not treat it as a final mark. See *Placeholders & substitutions*.

---

## Content fundamentals

**Voice: a senior engineer who has read your incident report.** Direct, specific, slightly dry. The brand sells judgment, so the writing has to demonstrate it.

**Person.** "We" for Crowd4Test, "you" for the customer. Never "our clients", never third person. *"We reply within one business day."* / *"Bring a build. Leave with findings."*

**Casing.** Sentence case everywhere — headlines, buttons, nav, table headers, badges are the only exception (mono uppercase with 0.08–0.12em tracking). Never Title Case A Headline Like This.

**Sentence shape.** Short declarative sentences. A claim, then the evidence. Contractions are fine and preferred in headlines (*"AI can't grade its own homework"*). One idea per sentence; if a sentence needs a semicolon to survive, split it.

**Numbers are the argument.** Every proof surface leads with a measured figure and names what it measures: *"−94% regression cycle time"*, not *"dramatically faster"*. Use the true minus sign (−) for reductions, × for multipliers, and tabular figures. If we couldn't measure it, we don't claim it.

**Headlines make a claim you could disagree with.**
- ✅ "Your regression suite is a museum."
- ✅ "Your model is confident. That is not the same as correct."
- ❌ "Comprehensive quality assurance solutions"
- ❌ "Revolutionize your QA with AI-powered synergy!"

**Banned:** exclamation marks, emoji, "seamless", "leverage", "unlock", "empower", "cutting-edge", "game-changing", "solutions" as a noun on its own. No sentence may end in an exclamation mark, including in CTAs.

**CTAs** are verb-first and concrete: *Book a demo*, *Scope a pilot*, *Talk to an engineer*, *Read the report*. Never *Learn more*, *Get started* or *Click here*. Reassurance sits under the button, small and factual: *"No sales sequence."* / *"We reply within one business day."*

**Error and empty states** admit the problem plainly and file it: the 404 reads *"We test for this, you know — the finding has been filed."* Self-deprecating, never cute.

**Body copy** runs 1.6 line-height at 16–18px and stays under ~75 characters per line. Two to three sentences per paragraph.

---

## Visual foundations

### Colour

A near-monochrome warm neutral system with **one** accent. The page is ~92% ink-on-white; coral appears two or three times per screen and each appearance is an action or a brand marker.

- **Coral `--coral-500` #e8532f** — primary CTAs, active tabs, mega-menu icons, eyebrow labels, the "4" in the wordmark. Hover darkens to `--coral-600`, press to `--coral-700`. Never used as a large background except on the `brand` CTA banner (campaign pages only).
- **Ink `--ink-950` #17130f** — all primary text and the inverse surface. Warm, never pure black, never pure grey.
- **Verify teal `--teal-500` #0b7a6e** — the second, quieter voice: checklist ticks, "included" markers, pass states, AI-agent surfaces. It is a *confirmation* colour, never an action colour.
- **Status** greens/ambers/reds/blues exist for UI feedback only and never appear in marketing composition.

Three page floors: `canvas` (white), `sunken` (`--ink-50`), `inverse` (`--ink-950`). Pages alternate canvas/sunken and use inverse at most twice — typically the KPI band and the footer.

### Type

**Instrument Sans** for everything visible; **JetBrains Mono** for eyebrows, badges, metadata and table keys. The mono is doing brand work, not code work: it makes the page read like instrumentation, which is what the company sells.

Display sizes are large and tightly tracked (72px at −2.6px, 56px at −1.8px) at weight 600 — never 700, which reads as shouting in this face. Body is 400 at 1.6. The single loudest moment on any page is a **56px tabular metric** in `StatBlock`; type carries hierarchy here because there is no photography to lean on.

### Layout & spacing

4px base grid (2px micro-step). Container 1200px, wide shells 1360px, prose 720px. Sections are 96px vertical (64px compact, 64px on mobile). Cards are 24px padded (32px for tall service cards) with 20px grid gaps. Grids drop columns cleanly — 3 → 2 → 1 — and never reflow rows.

### Shape, borders, elevation

Crisp, not soft: 6px on buttons and inputs, 10px on cards, 14px on panels, fully round only on pills and avatars. **Hairlines do most of the structural work** — `--border-default` #e4dfd9 at 1px separates nearly everything. Four shadow tiers exist but three of them are barely visible; `--shadow-md` appears only on card hover and open menus, `--shadow-lg` only on the highlighted pricing plan and modals. No inner shadows, no glows, no coloured shadows.

### Backgrounds & imagery

No gradients, no textures, no patterns, no illustration system. Backgrounds are flat colour, full stop. Imagery is intended to be photography — real testers, real screens — but **none was supplied**, so every image position renders a `Media` placeholder plate (sunken fill, hairline, mono caption). Intended treatment when real photography arrives: warm, natural light, un-styled, people over hardware; product screenshots at true pixel scale, never tilted in a 3D mock.

### Motion

Functional and short. `140ms` for control states, `200ms` for surfaces, one curve (`cubic-bezier(.2,0,0,1)`). Cards lift **2px** on hover with a shadow and a border darken. Nothing bounces, nothing slides more than 8px, nothing autoplays. `prefers-reduced-motion` zeroes every duration.

### States

- **Hover:** buttons darken (never lighten, never scale); cards lift 2px + `--shadow-md`; links go `--coral-700` with a 3px-offset underline; nav links go from `--ink-700` to `--ink-950`.
- **Press:** colour deepens one step. No transform, no shrink.
- **Focus:** 2px solid ink outline at 2px offset — visible on every interactive element, inverted to white on dark surfaces. Inputs use a 3px soft ink ring rather than an outline.
- **Disabled:** 55% opacity + `not-allowed`. Never a grey-on-grey redraw.

### Transparency & blur

Used almost nowhere. The only transparencies in the system are `rgb(255 255 255 / 0.08–0.10)` for hover and badge fills on inverse surfaces, and the modal scrim at 55%. No frosted glass, no backdrop blur.

### Accessibility

Body text meets 4.5:1 on every surface; coral on white is used for large text, icons and fills — never for small body copy (that's `--text-brand` #cc3f1d). Touch targets are ≥44px (48px for primary CTAs). Icon-only controls require a `label`. Focus is never suppressed.

---

## Iconography

**Lucide** (ISC licence), loaded from `unpkg.com/lucide-static@0.544.0` and rendered through the `Icon` component as a CSS mask so every glyph inherits `currentColor`. **This is a substitution** — no icon set was supplied with the brief. Lucide was chosen for its 2px stroke and geometric neutrality, which sits correctly next to Instrument Sans.

Rules: outline only (no filled variants), 2px stroke, sizes 16 / 20 / 24 / 32. Icons are `--text-secondary` by default; coral only inside feature tiles and mega-menu rows; teal only for confirmation ticks. **No emoji anywhere.** No Unicode characters as icons (the only exceptions: the true minus `−`, multiplication `×` and middot `·` in metrics and meta rows). Never hand-roll an SVG — if a needed glyph isn't in Lucide, ask.

---

## Index

| Path | What |
|---|---|
| `styles.css` | Global entry point — `@import` list only |
| `tokens/` | `fonts.css` · `colors.css` · `typography.css` · `spacing.css` · `radius.css` · `elevation.css` · `motion.css` · `base.css` · `interactions.css` |
| `components/core/` | Button, IconButton, Icon, Badge, Tag, Logo |
| `components/forms/` | Field, Input, Textarea, Select, Checkbox, Radio, Switch |
| `components/navigation/` | TopNav, Footer, Tabs, Pagination, Breadcrumb |
| `components/marketing/` | Hero, Section, SectionHeader, CapabilitySection, FeatureCard, ServiceCard, IndustryCard, ResourceCard, CaseStudyCard, StatBlock, LogoCloud, Testimonial, PricingTable, FaqAccordion, CtaBanner, ContactForm, Media |
| `ui_kits/website/` | The marketing site kit — 17 screens, `README.md` inside |
| `guidelines/` | 17 foundation specimen cards (Colors, Type, Spacing, Brand) |
| `thumbnail.html` | Project tile |
| `SKILL.md` | Agent Skills entry point |

### Components

**Core** — `Button`, `IconButton`, `Icon`, `Badge`, `Tag`, `Logo`
**Forms** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`
**Navigation** — `TopNav`, `Footer`, `Tabs`, `Pagination`, `Breadcrumb`
**Marketing** — `Hero`, `Section`, `SectionHeader`, `CapabilitySection`, `FeatureCard`, `ServiceCard`, `IndustryCard`, `ResourceCard`, `CaseStudyCard`, `StatBlock`, `LogoCloud`, `Testimonial`, `PricingTable`, `FaqAccordion`, `CtaBanner`, `ContactForm`, `Media`

Each component directory holds `<Name>.jsx`, `<Name>.d.ts` (props contract), `<Name>.prompt.md` (usage) and one `@dsCard` HTML showcase.

### UI kit screens

Homepage · Platform · Solutions · Industries · AI Testing Services · Case Studies · Customer Stories · Resources & Insights · Blog · Blog post · FAQs · Pricing · About Us · Careers · Contact / Book a Demo · Thank You · 404 — all wrapped in the global `TopNav` (mega menus) and `Footer`.

---

## Intentional additions

The brief listed marketing section types rather than a component inventory, so a small number of primitives were added to make those sections buildable:

- **`Icon`** — a wrapper for the Lucide set, so no screen hand-rolls an SVG.
- **`Media`** — a photography placeholder plate, because no image library was supplied.
- **`Section` / `SectionHeader`** — page rhythm and heading structure, so vertical spacing is a token rather than a per-page decision.
- **`Field`** — label/hint/error wrapper, so no input ships with a placeholder as its only label.

## Placeholders & substitutions — please review

1. **Logo.** No artwork supplied. The wordmark is type only. → *Send real logo files.*
2. **Fonts.** Instrument Sans + JetBrains Mono, loaded from Google Fonts. Chosen, not given. → *Confirm, or send licensed brand fonts and I'll swap the `@font-face` layer.*
3. **Icons.** Lucide, via CDN. A substitution. → *Confirm, or point me at your icon set.*
4. **Photography.** None supplied; every image slot is a `Media` plate. → *Send photography or an art direction reference.*
5. **Customer names, logos, statistics, case studies and quotes** in the UI kit are invented placeholders. → *Replace before anything is published.*

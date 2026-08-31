# Handoff supplement — Crowd4Test → Next.js

Companion to `design_handoff_crowd4test_website/`, which Claude Code is already
working from. Add these three things to the repo; nothing here replaces the original
package.

## 1. `CLAUDE.md` — do this first

Copy `CLAUDE.md` from this folder to the **root of the Next.js repo**.

Claude Code reads it automatically at the start of every conversation, so the
non-negotiables (no raw hex, no Tailwind, no CMS, teal accent, copy rules, banned
words) survive context resets and new sessions. The handoff README is read once;
this is read always. If a rule keeps getting broken, add a line to this file rather
than repeating yourself in chat.

Merge it if a `CLAUDE.md` already exists.

## 2. `ds_components/` — readable design-system sources

The original package shipped `_ds_bundle.js`, which is compiled and dense. This folder
has the same 30 components as readable source, each with three files:

- `<Name>.jsx` — the implementation
- `<Name>.d.ts` — the prop contract, the fastest thing to read when porting
- `<Name>.prompt.md` — usage notes: when to use it, what not to do with it

```
ds_components/
  core/        Button IconButton Icon Badge Tag Logo
  forms/       Field Input Textarea Select Checkbox Radio Switch
  navigation/  TopNav Footer Tabs Pagination Breadcrumb
  marketing/   Hero Section SectionHeader CapabilitySection FeatureCard ServiceCard
               IndustryCard ResourceCard CaseStudyCard StatBlock LogoCloud Testimonial
               PricingTable FaqAccordion CtaBanner ContactForm Media
```

Copy it into the repo (e.g. `design_reference/ds_components/`) and tell Claude Code:

> Port design-system components from `design_reference/ds_components/` — readable JSX
> with `.d.ts` prop contracts and `.prompt.md` usage notes — instead of the compiled
> `_ds_bundle.js`. Follow each `.d.ts` exactly for the TypeScript prop types.

The `.card.html` files in each folder are visual showcases — open them in a browser to
see every variant of a component at once.

## 3. `screenshots/` — the rendered design

Twelve captures of the working prototype. Claude Code reads images; attaching the
relevant one is far tighter than describing a layout in prose.

| File | What it shows |
|---|---|
| `01-home-hero` | Announcement bar, TopNav, dark hero with glow + grid layers |
| `02-home-logos` | Light section, logo/tester marquee |
| `03-home-problem-bento` | The bento grid — tall left card, wide top-right, two below |
| `04-home-services` | Service card grid |
| `05-home-platform` | Dark platform section |
| `06-home-case-studies` | Case-study carousel |
| `07-home-testimonials` | Dark testimonial section |
| `08-home-footer` | Final CTA + footer |
| `09-detail-hero` | Detail-page hero (the `[slug]` template) |
| `10-detail-body` | Detail-page coverage grid and stat band |
| `11-pricing` | Pricing table, highlighted plan |
| `12-contact` | Contact form |

Use them like this:

> Here's how the problem section should look [attach `03-home-problem-bento.png`].
> Compare it to what you built and fix the differences.

## Two things only you can tell it

- **Deploy target** — Vercel, self-hosted Node, or static export. It changes
  `next.config`, image optimisation, and whether the contact form's server action is
  available at all. On static export you need an external form endpoint.
- **An existing repo to imitate**, if your team has Next.js conventions already.
  "Follow the patterns in X" beats letting it invent a structure.

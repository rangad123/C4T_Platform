#!/usr/bin/env node
/**
 * Launch readiness check.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The site is built. What is NOT resolved is content the Client owns: certification
 * claims, outcome figures, a testimonial, case studies, photography, the logo, and
 * two literal "Up to X" placeholders on the pricing page. Every one is marked with
 * a ⚠ comment where it lives, but a comment is a memory test, and the items that
 * matter most here — "ISO/IEC 27001 certified", "SOC 2 Type II" — are ones a buyer
 * can act on and a regulator can check.
 *
 * So the check is mechanical. Run it before any production deploy:
 *
 *   npm run launch-check
 *
 * It exits 1 while blockers remain. It is deliberately NOT wired into `build`:
 * building a production bundle for staging is legitimate, and a build that refuses
 * to run is the kind of obstruction people work around by deleting the check.
 * Wire it into the deploy pipeline instead, where the decision actually lands.
 *
 * A blocker clears by resolving the content, not by editing this file. If an item
 * genuinely does not apply, delete its entry and say why in the commit.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** @type {{ id: string, severity: 'blocker'|'warning', file: string, find: string|RegExp, why: string }[]} */
const CHECKS = [
  // ── Claims a customer or regulator can act on ────────────────────────────
  {
    id: 'iso-27001-claim',
    severity: 'blocker',
    file: 'src/content/home.ts',
    find: 'ISO/IEC 27001',
    why: 'Certification claim. Publishing it without a current certificate is a misrepresentation. Appears in the hero trust line, the homepage trust card, the platform security list, the contact rail and the Trust page.',
  },
  {
    id: 'soc2-claim',
    severity: 'blocker',
    file: 'src/content/home.ts',
    find: 'SOC 2 Type II',
    why: 'Audited attestation. Same as above — needs the report in hand.',
  },
  {
    id: 'trust-page-certifications',
    severity: 'blocker',
    file: 'src/content/company.ts',
    find: 'HIPAA-ready workflows',
    why: 'The Trust page Certifications panel is where a security reviewer looks first. Every line needs its certificate, audit report or DPA, or must be deleted.',
  },

  // ── Figures presented as fact ────────────────────────────────────────────
  {
    id: 'unverified-stats',
    severity: 'blocker',
    file: 'src/content/stats.ts',
    find: 'NONE OF THESE ARE VERIFIED',
    why: 'Tester count, country count, device count, client count, languages and the survey sample. Confirm each against real records, then delete the warning block to clear this check.',
  },
  {
    id: 'unverified-outcomes',
    severity: 'blocker',
    file: 'src/content/home.ts',
    find: "{ value: '40%', label: 'Faster regression cycles' }",
    why: 'Outcome claims ("40% faster regression cycles") on the homepage and the case-study index. Each needs a named engagement behind it.',
  },
  {
    id: 'years-in-business',
    severity: 'warning',
    file: 'src/content/stats.ts',
    find: "value: '11 years'",
    why: 'Derived from the 2015 founding date and goes stale on its own. Check it each year.',
  },

  // ── Fabricated-looking content ───────────────────────────────────────────
  {
    id: 'placeholder-testimonial',
    severity: 'blocker',
    file: 'src/content/home.ts',
    find: 'Testimonial quote goes here',
    why: 'The handoff placeholder is still rendering on the homepage. Replace with a real, attributable quote with written consent, or delete the section.',
  },
  {
    id: 'placeholder-case-studies',
    severity: 'blocker',
    file: 'src/content/case-studies.ts',
    find: "client: 'Case study one'",
    why: 'All three case studies are placeholders. They are drafts, so production hides them — but the homepage and About carousels still render the cards. content.md §12.3: every metric traceable, every named client approved in writing.',
  },
  {
    id: 'pricing-x-placeholders',
    severity: 'blocker',
    file: 'src/content/pages.ts',
    find: 'Up to X test hours',
    why: 'Literal "Up to X test hours" and "Up to X markets and X languages" on the Pricing page a buyer reads before asking for a number.',
  },
  {
    id: 'no-published-posts',
    severity: 'warning',
    file: 'src/content/blog.ts',
    find: /status: 'published'/,
    invert: true,
    why: 'No blog post is published, so /company/blog shows its empty state. Fine to launch with; the blog is a growth channel, not a blocker.',
  },

  // ── Assets ───────────────────────────────────────────────────────────────
  {
    id: 'unsplash-photography',
    severity: 'blocker',
    file: 'src/content/media.ts',
    find: 'images.unsplash.com',
    why: 'Every photograph is a hotlinked Unsplash placeholder. Agreement §5 makes sourcing real media the Client\'s responsibility. Self-host the final set, remove the "Placeholder · Unsplash licence" captions, and drop the Unsplash host from next.config.ts.',
  },
  {
    id: 'apple-icon',
    severity: 'warning',
    file: 'src/app/apple-icon.tsx',
    invert: true,
    why: 'The 180px apple-touch-icon is missing. iOS Safari uses it for "Add to Home Screen" and proxied share previews. Add app/apple-icon.tsx when the brand supplies a 180px square icon — `next/image` is not available there, so the SVG or a hand-sized PNG is the simplest path.',
  },
  // The wordmark / Logo check was removed once the real logo landed in
  // public/logo.svg. The old placeholder note is gone from Logo.tsx — the OG
  // card now reads the same file at build time.

  // ── Wiring ───────────────────────────────────────────────────────────────
  {
    id: 'leads-env',
    severity: 'blocker',
    file: '.env.example',
    find: /^(?!.*API_ORIGIN)/s,
    why: 'The demo form posts to API_ORIGIN + /v1/leads. If that variable is unset in the deployed environment it falls back to localhost, every submission fails, and the enquiry survives only in the server log. Set it before launch.',
  },
  {
    id: 'analytics-vendor',
    severity: 'warning',
    file: 'src/components/analytics/Analytics.tsx',
    find: 'NO VENDOR IS CONFIGURED',
    why: 'The consent gate is built; no provider is chosen. Requires a Client decision plus a privacy-policy and sub-processor update.',
  },
  {
    id: 'legal-pages',
    severity: 'blocker',
    file: 'src/app/(marketing)/legal/[slug]/page.tsx',
    find: 'Scaffold',
    why: 'Terms, Privacy, Cookies, DPA and the Accessibility Statement are still scaffolds. The cookie banner links to /legal/cookies, and the Trust page promises a DPA. These need real legal text, not drafted copy.',
  },
  // `social-profiles` was retired here. It warned that the Organization JSON-LD
  // `sameAs` array held two hand-written, unverified URLs. The client has since
  // supplied all four confirmed profiles, they live in SOCIAL_PROFILES in
  // content/nav.ts, and both the footer and the JSON-LD derive from that one
  // array — so there is no longer an unverified URL to warn about.
  //
  // It is deleted rather than left in place because its needle
  // ('linkedin.com/company/crowd4test' in structured-data.ts) no longer appears
  // in that file, so the check had already stopped firing on its own. A check
  // that passes because its grep target moved is worse than no check: it reads
  // as evidence when it is only silence.
]

let blockers = 0
let warnings = 0
const lines = []

for (const check of CHECKS) {
  let source
  try {
    source = readFileSync(join(ROOT, check.file), 'utf8')
  } catch {
    lines.push(`  ?  ${check.id} — could not read ${check.file}; the check itself needs updating`)
    warnings++
    continue
  }

  const found =
    typeof check.find === 'string' ? source.includes(check.find) : check.find.test(source)
  const present = check.invert ? !found : found
  if (!present) continue

  const tag = check.severity === 'blocker' ? 'BLOCKER' : 'warning'
  if (check.severity === 'blocker') blockers++
  else warnings++

  lines.push(`\n  ${tag}  ${check.id}`)
  lines.push(`           ${check.file}`)
  lines.push(`           ${check.why}`)
}

console.log('\nCrowd4Test — launch readiness')
console.log('='.repeat(72))

if (lines.length === 0) {
  console.log('\n  Nothing outstanding. Every tracked item has been resolved.\n')
  process.exit(0)
}

console.log(lines.join('\n'))
console.log('\n' + '='.repeat(72))
console.log(
  `  ${blockers} blocker${blockers === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
)
console.log(
  blockers > 0
    ? '\n  Do not deploy to production. Blockers are claims, assets or wiring that\n  would mislead a visitor or lose their enquiry.\n'
    : '\n  No blockers. Warnings are worth reading before launch.\n',
)

process.exit(blockers > 0 ? 1 : 0)

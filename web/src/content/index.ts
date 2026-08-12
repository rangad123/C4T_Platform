/**
 * Site content. No CMS (CLAUDE.md rule 4) — every word on the marketing site is
 * a typed export from this folder, transcribed from
 * `design_handoff_crowd4test_website/design/content.md`.
 *
 * WHY THIS EXISTS AS A BARREL. Pages import from `@/content`, so a content
 * module can be split or renamed without touching a page. It also gives the
 * "never write new marketing copy" rule a single boundary to check: if a string
 * appears in a page file rather than here, it is a violation.
 *
 * ⚠ UNRESOLVED CONTENT lives in these modules and is marked at each definition:
 *  - `stats.ts`        every claim-bearing figure, all unverified
 *  - `home.ts`         TESTIMONIAL, CASE_STUDIES, TRUST certifications
 *  - `pages.ts`        "Up to X test hours" placeholders in the Pilot plan
 *  - `company.ts`      the Trust page certifications group, an empty roles list
 *  - `media.ts`        every photograph is an Unsplash placeholder
 *  - `blog.ts`         no post has a body; every entry is a draft
 *  - `case-studies.ts` every entry is a placeholder; see the §12.3 warning
 */

export * from './nav'
export * from './stats'
export * from './clients'
export * from './media'
export * from './home'
export * from './pages'
export * from './company'
export * from './details'
export * from './blog'
export * from './case-studies'

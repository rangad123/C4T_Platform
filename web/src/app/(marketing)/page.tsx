import type { Metadata } from 'next'
import {
  Button,
  CapabilitySection,
  CaseStudyCard,
  CtaBanner,
  FeatureCard,
  Hero,
  Icon,
  LogoWall,
  ResourceCard,
  Section,
  SectionHeader,
  ServiceCard,
  SiteImage,
  StatBlock,
  Tag,
  Testimonial,
} from '@/components/ds'
import { Carousel } from '@/components/sections/Carousel'
import s from '@/components/sections/sections.module.css'
import { buildMetadata } from '@/lib/seo/metadata'
import {
  AI_SERVICES,
  CASE_STUDY_ENTRIES,
  CLIENTS,
  CLOSING_CTA,
  HOME_CARDS,
  HOME_HERO,
  HOME_SECTIONS,
  INDUSTRIES,
  INTEGRATIONS,
  PHOTOS,
  PLATFORM_MODULES,
  PROBLEMS,
  QA_SERVICES,
  RESOURCES,
  RESULTS,
  STEPS,
  TESTIMONIAL,
  TRUST,
  USE_CASES,
} from '@/content'
import { STAT_BAND } from '@/content/stats'

const PATH = '/'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * The homepage.
 *
 * RHYTHM IS FIXED. `design/site/App.jsx` shipped a tweaks panel with a
 * dark/light `rhythm` switch, and Home.jsx branched on it everywhere via
 * `T(darkTone, lightTone)` and `deep()`. CLAUDE.md rule 9 fixes rhythm to
 * `contrast`, so that branch is resolved: every `T()` call collapses to its dark
 * arm and `deep()` is always the class. Nothing here is conditional on a theme.
 *
 * The band order is the source's, and it is the argument the page makes:
 * problem → approach → what we test → how → proof → close. Each dark band is
 * separated from the next by a light one; two darks in a row would read as one
 * long section.
 *
 * WHAT IS NOT REAL YET. The testimonial and the three case studies are the
 * handoff's visible placeholders — "Testimonial quote goes here…", "Case study
 * one", "00%". They render because they read unmistakably as placeholders and
 * because the sections need to exist to be reviewed; they must be replaced
 * before launch. See the ⚠ notes in content/home.ts. The same goes for every
 * photograph and the certification line under the hero.
 */
export default function HomePage() {
  return (
    <>
      <Hero
        className={s.deep}
        tone="inverse"
        // No eyebrow: it repeated the opening of the headline word for word.
        // See the note in content/home.ts.
        title={HOME_HERO.title}
        // Tints the closing "Human Intelligence" in the accent. Teal-100 on
        // this dark band, not teal-500 — see the note in Hero.
        titleHighlight={HOME_HERO.titleHighlight}
        description={HOME_HERO.description}
        primaryCta={HOME_HERO.primaryCta}
        primaryHref="/contact"
        secondaryCta={HOME_HERO.secondaryCta}
        secondaryHref="/contact"
        bullets={[
          '2-week pilot · Fixed scope',
          'Named QA lead on every engagement',
          'Results triaged in your Jira',
        ]}
        trustLine={HOME_HERO.trustLine}
        // The headline is long — nine words — and at the default measure it
        // broke over four lines, which reads as a paragraph rather than a
        // statement. `copy-led` narrows the media column and lifts the copy
        // cap so it sets in three. The art loses width; it is a wide
        // illustration and crops to the same 4:3 box either way.
        mediaWidth="copy-led"
        media={
          // The brand artwork. This slot held `public/home.mp4` until the
          // still was supplied; the geometry is unchanged, because the mask,
          // the upward nudge and the container bleed all describe a rectangle
          // rather than an element type. See `.c4t-hero-media` in
          // overrides.css and the `heroLanding` note in content/media.ts.
          <SiteImage
            src={PHOTOS.heroLanding.src}
            alt={PHOTOS.heroLanding.alt}
            fill
            // `priority` because this IS the LCP element on the homepage.
            // Without it Next lazy-loads the hero, which is the one image on
            // the site that must never wait.
            priority
            // The frame renders at ~610px in the container and up to ~830px
            // once the bleed applies, so the browser never needs a
            // full-viewport asset here. Left at the container's real ceiling
            // rather than the default 50vw, which over-fetches on wide screens.
            sizes="(max-width: 900px) 100vw, 830px"
            // No rounded corners: the edges are feathered to transparent by
            // the mask, so there is no visible corner left to round.
            radius="0"
            // MUST BE INLINE. <SiteImage> sets `background: var(--surface-sunken)`
            // as an inline style so a slow load shows a surface instead of a
            // hole. Inline beats any external stylesheet, so the `background:
            // transparent` in overrides.css does NOT win — measured at
            // rgb(241,237,232) on the rendered wrapper. On this hero that light
            // floor shows straight through the feathered edges as a pale
            // rectangle on the ink-950 band, which is precisely what the mask
            // exists to avoid. SiteImage spreads `style` last, so this overrides
            // it. Removing this line silently brings the rectangle back.
            style={{ background: 'transparent' }}
            // ALL geometry lives in overrides.css against this class, and
            // deliberately so: this slot previously carried an inline
            // `width: 100%`, and an inline style outranks any external
            // stylesheet rule short of `!important`. That silently defeated the
            // width rule in overrides.css — the mask and the vertical nudge
            // applied, because neither is an inline property, but every attempt
            // to widen the frame was overridden and had no effect. Keeping the
            // box model in one place is what stops that recurring.
            className="c4t-hero-media"
          />
        }
      />

      {/* ─── Marquee ─────────────────────────────────────────────────────── */}
      <Section tone="inverse" compact className={`${s.deep} ${s.edge}`}>
        <div
          className="c4t-eyebrow"
          style={{ textAlign: 'center', color: 'var(--text-inverse-muted)' }}
        >
          Working with teams in
        </div>
        <div className={s.marquee} style={{ marginTop: 28 }}>
          <div className={s.marqueeTrack}>
            {[0, 1].map((dup) => (
              // The second set is the seam filler. It carries the same words, so
              // it is hidden from assistive tech to avoid reading them twice.
              <div key={dup} className={s.marqueeSet} aria-hidden={dup === 1}>
                {MARQUEE.map((sector) => (
                  <span
                    key={sector}
                    className="c4t-heading-md"
                    style={{ color: 'var(--text-inverse-muted)', whiteSpace: 'nowrap' }}
                  >
                    {sector}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ─── Stat band ───────────────────────────────────────────────────── */}
      <Section tone="sunken" className={s.airy}>
        <StatBlock className={s.stats5} stats={STAT_BAND} columns={5} />
      </Section>

      {/* ─── The problem, as a bento ─────────────────────────────────────── */}
      <Section>
        <SectionHeader {...HOME_SECTIONS.problem} />
        <div
          className={s.bento}
          style={{
            display: 'grid',
            gridTemplateColumns: '1.15fr 1fr 1fr',
            gridAutoRows: 'minmax(210px, auto)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {PROBLEMS.map((p, i) => (
            <FeatureCard key={p.title} {...p} style={{ ...BENTO_CARD, ...BENTO_PLACEMENT[i] }} />
          ))}
        </div>
      </Section>

      {/* ─── The approach: three alternating step rows ───────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <SectionHeader tone="inverse" {...HOME_SECTIONS.approach} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 72, marginTop: 72 }}>
          {STEPS.map((step, i) => {
            const flip = i % 2 === 1
            const photo = STEP_PHOTOS[i]
            return (
              <div key={step.n} className={s.stepRow}>
                <div style={{ order: flip ? 2 : 1 }}>
                  {photo ? (
                    <SiteImage
                      src={photo.src}
                      alt={photo.alt}
                      fill
                      ratio="16 / 10"
                      sizes="(max-width: 900px) 100vw, 50vw"
                    />
                  ) : null}
                </div>
                <div style={{ order: flip ? 1 : 2, maxWidth: 460 }}>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--type-caption-size)',
                      fontWeight: 'var(--fw-semibold)',
                      letterSpacing: 'var(--type-eyebrow-tracking)',
                      color: 'var(--text-inverse-muted)',
                    }}
                  >
                    {step.n}
                  </div>
                  <h3
                    className="c4t-heading-lg"
                    style={{ margin: '16px 0 0', color: 'var(--text-inverse)', textWrap: 'pretty' }}
                  >
                    {step.title}
                  </h3>
                  <p
                    className="c4t-body-md"
                    style={{ margin: '14px 0 0', color: 'var(--text-inverse-muted)' }}
                  >
                    {step.body}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ marginTop: 44 }}>
          <Button variant="inverse" iconRight="arrow-right" href="/platform">
            See how it works
          </Button>
        </div>
      </Section>

      {/* ─── QA services ─────────────────────────────────────────────────── */}
      {/*
        ORDER: QA services now precedes AI quality. The two were the other way
        round, following content.md §4.5 → §4.6.

        THE TONES DID NOT MOVE WITH THEM. Each band's tone belongs to its
        POSITION in the page, not to its content — the page alternates
        canvas/sunken/inverse deliberately so no two adjacent bands share a
        surface. Carrying `tone="sunken"` up here with the services content
        would have put a sunken band directly against the sunken stat band's
        neighbour and flattened the rhythm. So the first slot keeps canvas and
        the second keeps sunken, and only the contents swapped.
      */}
      <Section>
        <SectionHeader
          {...HOME_SECTIONS.services}
          actions={
            <Button variant="secondary" iconRight="arrow-right" href="/services">
              {HOME_SECTIONS.services.action.label}
            </Button>
          }
        />
        <div className="c4t-grid-4" style={GRID_4}>
          {QA_SERVICES.map((service) => (
            <FeatureCard
              key={service.slug}
              icon={service.icon}
              title={service.title}
              description={service.description}
              meta={service.meta}
              href={`/services/${service.slug}`}
            />
          ))}
        </div>
      </Section>

      {/* ─── AI quality ──────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader
          {...HOME_SECTIONS.aiQuality}
          actions={
            <Button variant="secondary" iconRight="arrow-right" href="/ai-testing">
              {HOME_SECTIONS.aiQuality.action.label}
            </Button>
          }
        />
        <div className="c4t-grid-4" style={GRID_4}>
          {AI_SERVICES.map((service) => (
            <ServiceCard
              key={service.slug}
              icon={service.icon}
              eyebrow={service.eyebrow}
              title={service.title}
              description={service.description}
              points={service.points}
              badge={service.badge}
              href={`/ai-testing/${service.slug}`}
            />
          ))}
        </div>
      </Section>

      {/* ─── The platform ────────────────────────────────────────────────── */}
      <CapabilitySection
        className={s.deep}
        tone="inverse"
        eyebrow={HOME_SECTIONS.platform.eyebrow}
        title={HOME_SECTIONS.platform.title}
        description={HOME_SECTIONS.platform.description}
        capabilities={PLATFORM_MODULES}
        media={
          // Client-supplied `ai.jpg`. `PHOTOS.triage` still backs the AI Testing
          // hub hero and the detail rotation, so it stays defined.
          //
          // `c4t-media-dim` settles the frame into the ink-950 band — see
          // overrides.css. It was added for the robot photo, whose cyan fought
          // the warm band; this image is already low-chroma, so the filter does
          // much less work here. Drop the class if it reads as murky.
          <SiteImage
            src={PHOTOS.ai.src}
            alt={PHOTOS.ai.alt}
            className="c4t-media-dim"
            fill
            ratio="4 / 3"
            sizes="(max-width: 900px) 100vw, 55vw"
          />
        }
      />

      {/* ─── Client wall ─────────────────────────────────────────────────── */}
      {/*
        content.md §4.2 specifies this slot as "Trusted by teams building at
        scale" over `{{Client logo × 8}}`. It sits between the platform section
        and the AI use cases, on the light band — the two sections either side
        are both `tone="inverse"`, so a canvas band here also restores the
        dark/light alternation the page rhythm is built on.

        `tone="canvas"` is --ink-50, the page floor, NOT #fff. CLAUDE.md rule 2
        bars pure white from composition.

        ⚠ EVERY NAME NEEDS WRITTEN PERMISSION BEFORE THIS IS PUBLIC. §4.2 and
        the §14 asset table both say so, and `npm run launch-check` fails while
        any entry in content/clients.ts still has `permission: false`.
      */}
      <Section tone="canvas" compact>
        <div className="c4t-eyebrow" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          Trusted by teams building at scale
        </div>

        <LogoWall clients={CLIENTS} className={s.clientWall} />
      </Section>

      {/* ─── AI use cases ────────────────────────────────────────────────── */}
      <Section tone="inverse" compact className={`${s.deep} ${s.edge}`}>
        <div
          className={s.splitSticky}
          style={{
            display: 'grid',
            gridTemplateColumns: '380px 1fr',
            gap: 80,
            alignItems: 'start',
          }}
        >
          <div>
            <div className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
              AI use cases
            </div>
            <h2
              className="c4t-display-md"
              style={{ margin: '16px 0 0', color: 'var(--text-inverse)' }}
            >
              What we test.
            </h2>
            <div style={{ marginTop: 'var(--space-6)' }}>
              <Button variant="inverse-ghost" iconRight="arrow-right" href="/ai-testing">
                Explore AI testing
              </Button>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {USE_CASES.map((useCase) => (
              <Tag key={useCase} tone="inverse">
                {useCase}
              </Tag>
            ))}
          </div>
        </div>
      </Section>

      {/* ─── Full-bleed plate ────────────────────────────────────────────── */}
      <div style={{ background: 'var(--surface-sunken)' }}>
        <SiteImage
          src={PHOTOS.team.src}
          alt={PHOTOS.team.alt}
          fill
          ratio="21 / 6"
          radius="0"
          sizes="100vw"
        />
      </div>

      {/* ─── Industries ──────────────────────────────────────────────────── */}
      <Section className={s.airy}>
        {/* No trailing action: rule 10 bars the /industries pages, so the
            header would otherwise link nowhere. */}
        <SectionHeader {...HOME_SECTIONS.industries} />
        {/* `c4t-grid-4` is doing the responsive work, not the column count —
            it is the only class that collapses a wide grid, and without it the
            inline `repeat(5, 1fr)` stays five columns at every width. On a
            360px phone that overflowed the rounded container and the domain
            names were clipped mid-word. */}
        <div
          className="c4t-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 0,
            marginTop: 48,
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-panel)',
            overflow: 'hidden',
            background: 'var(--surface-canvas)',
          }}
        >
          {INDUSTRIES.map((industry) => (
            <div
              key={industry.name}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                padding: '24px 20px',
                borderRight: '1px solid var(--border-default)',
                borderBottom: '1px solid var(--border-default)',
              }}
            >
              <Icon name={industry.icon} size={24} style={{ color: 'var(--accent-base)' }} />
              <div
                className="c4t-heading-sm"
                style={{ color: 'var(--text-primary)', textWrap: 'balance' }}
              >
                {industry.name}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ─── Customer stories ────────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <SectionHeader tone="inverse" {...HOME_SECTIONS.stories} />
        <div style={{ marginTop: 48 }}>
          <Testimonial
            tone="inverse"
            variant="feature"
            quote={TESTIMONIAL.quote}
            name={TESTIMONIAL.name}
            role={TESTIMONIAL.role}
            company={TESTIMONIAL.company}
          />
        </div>
        <div
          style={{ marginTop: 56, paddingTop: 48, borderTop: '1px solid var(--border-inverse)' }}
        >
          <StatBlock tone="inverse" stats={RESULTS} columns={3} align="left" />
        </div>
      </Section>

      {/* ─── Proof ───────────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader
          {...HOME_SECTIONS.proof}
          actions={
            <Button variant="secondary" iconRight="arrow-right" href="/company/case-studies">
              {HOME_SECTIONS.proof.action.label}
            </Button>
          }
        />
        <Carousel
          variant="deck"
          label="Case studies"
          itemNoun="case study"
          slides={CASE_STUDY_ENTRIES.map((study) => (
            <CaseStudyCard
              key={study.slug}
              client={study.client}
              industry={study.industry}
              headline={study.headline}
              results={study.results}
              href="/company/case-studies"
            />
          ))}
        />
      </Section>

      {/* ─── Twin cards ──────────────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <div className="c4t-grid-2" style={GRID_2}>
          <div style={PANEL}>
            <h2 className="c4t-heading-lg" style={{ margin: 0, color: 'var(--text-inverse)' }}>
              {HOME_CARDS.integrations.title}
            </h2>
            <p
              className="c4t-body-md"
              style={{ margin: '12px 0 28px', color: 'var(--text-inverse-muted)' }}
            >
              {HOME_CARDS.integrations.description}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {INTEGRATIONS.map((name) => (
                <Tag key={name} tone="inverse">
                  {name}
                </Tag>
              ))}
            </div>
            <div style={{ marginTop: 28 }}>
              <Button
                variant="inverse-ghost"
                iconRight="arrow-right"
                href={HOME_CARDS.integrations.action.href}
              >
                {HOME_CARDS.integrations.action.label}
              </Button>
            </div>
          </div>

          <div style={PANEL}>
            <h2 className="c4t-heading-lg" style={{ margin: 0, color: 'var(--text-inverse)' }}>
              {HOME_CARDS.trust.title}
            </h2>
            <p
              className="c4t-body-md"
              style={{ margin: '12px 0 28px', color: 'var(--text-inverse-muted)' }}
            >
              {HOME_CARDS.trust.description}
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
              {TRUST.map((item) => (
                <li key={item} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <Icon
                    name="check"
                    size={20}
                    style={{ color: 'var(--text-brand-inverse)', flex: 'none' }}
                  />
                  <span className="c4t-body-md" style={{ color: 'var(--text-inverse)' }}>
                    {item}
                  </span>
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 28 }}>
              <Button
                variant="inverse-ghost"
                iconRight="arrow-right"
                href={HOME_CARDS.trust.action.href}
              >
                {HOME_CARDS.trust.action.label}
              </Button>
            </div>
          </div>
        </div>
      </Section>

      {/* ─── Resources ───────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader
          {...HOME_SECTIONS.resources}
          actions={
            <Button variant="secondary" iconRight="arrow-right" href="/company/blog">
              {HOME_SECTIONS.resources.action.label}
            </Button>
          }
        />
        <Carousel
          variant="coverflow"
          label="Resources"
          itemNoun="resource"
          slides={RESOURCES.map((resource) => (
            <ResourceCard
              key={resource.title}
              type={resource.type}
              title={resource.title}
              description={resource.description}
              href="/company/blog"
            />
          ))}
        />
      </Section>

      {/* ─── Close ───────────────────────────────────────────────────────── */}
      <div className={s.deep} style={{ position: 'relative' }}>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </div>
    </>
  )
}

/* ─── Layout constants ──────────────────────────────────────────────────── */

/** Sector names in the marquee. content.md §4.2. */
const MARQUEE = [
  'Fintech',
  'Healthcare',
  'Retail',
  'Gaming',
  'Telecom',
  'AI',
  'Media',
  'Travel',
  'Education',
] as const

const GRID_4 = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 'var(--space-grid-gap)',
  marginTop: 48,
} as const

const GRID_2 = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 'var(--space-grid-gap)',
} as const

const PANEL = {
  border: '1px solid var(--border-inverse)',
  borderRadius: 'var(--radius-panel)',
  padding: 40,
  background: 'var(--surface-inverse-raised)',
} as const

/** The bento cards sit on the sunken tint, not canvas, so they read as inset. */
const BENTO_CARD = {
  background: 'var(--surface-sunken)',
  borderColor: 'var(--border-default)',
} as const

/**
 * Explicit placement: the first card is a tall left column, the second spans the
 * top right, and the last two split the bottom right. The `sections.module.css`
 * `bento` class unsets all of it below 900px.
 */
const BENTO_PLACEMENT = [
  {
    gridColumn: '1',
    gridRow: '1 / 3',
    display: 'flex',
    flexDirection: 'column',
    // The tall card spans both rows, so its content has roughly twice the
    // height to sit in. It was pinned to the bottom (`flex-end`), which left a
    // large empty field above the icon and made the card read as though the
    // artwork had failed to load. Centred, the block sits against the optical
    // middle of the two cards beside it.
    justifyContent: 'center',
  },
  { gridColumn: '2 / 4', gridRow: '1' },
  { gridColumn: '2', gridRow: '2' },
  { gridColumn: '3', gridRow: '2' },
] as const

/** The approach section's three photos, in step order. */
const STEP_PHOTOS = [PHOTOS.scoping, PHOTOS.hardware, PHOTOS.dashboard] as const

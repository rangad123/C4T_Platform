import type { Metadata } from 'next'
import {
  Button,
  CapabilitySection,
  CaseStudyCard,
  CtaBanner,
  FeatureCard,
  Hero,
  Icon,
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
        eyebrow={HOME_HERO.eyebrow}
        title={HOME_HERO.title}
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
        // The homepage is the only hero carrying a video, and a moving frame
        // needs more room than a still to read. 'wide' flips the split from
        // `1.05fr 1fr` to `1fr 1.25fr` — the media column goes from ~535px to
        // ~610px inside the 1200px container, about a third more area. Every
        // other hero keeps the default.
        mediaWidth="wide"
        media={
          // The brand video.
          //
          // The poster is the video's OWN first frame, extracted with ffmpeg to
          // `public/home-poster.jpg` (90 KB). It used to be an unrelated
          // Unsplash photo, which meant the hero visibly cut from a stock image
          // to the video the moment playback began. Using frame 1 means the
          // still and the first frame are identical, so there is nothing to
          // see — and it removes one more Unsplash dependency from the page.
          //
          // Regenerate it whenever home.mp4 changes:
          //   ffmpeg -y -i public/home.mp4 -vf "select=eq(n\,0)" \
          //     -vframes 1 -q:v 2 public/home-poster.jpg
          //
          // `autoplay muted playsInline` is the standard autoplay recipe —
          // `muted` is what lets Safari iOS play inline at all, `playsInline`
          // keeps the user on the page rather than going fullscreen. No
          // controls, no audio.
          <video
            src="/home.mp4"
            poster="/home-poster.jpg"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            // ALL geometry lives in overrides.css against this class, and
            // deliberately so: this element previously carried an inline
            // `width: 100%`, and an inline style outranks any external
            // stylesheet rule short of `!important`. That silently defeated the
            // width rule in overrides.css — the mask and the vertical nudge
            // applied, because neither is an inline property, but every attempt
            // to widen the frame was overridden and had no effect. Keeping the
            // box model in one place is what stops that recurring.
            className="c4t-hero-video"
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

      {/* ─── AI quality ──────────────────────────────────────────────────── */}
      <Section>
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

      {/* ─── QA services ─────────────────────────────────────────────────── */}
      <Section tone="sunken">
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

      {/* ─── The platform ────────────────────────────────────────────────── */}
      <CapabilitySection
        className={s.deep}
        tone="inverse"
        eyebrow={HOME_SECTIONS.platform.eyebrow}
        title={HOME_SECTIONS.platform.title}
        description={HOME_SECTIONS.platform.description}
        capabilities={PLATFORM_MODULES}
        media={
          // Client-supplied `robot.jpg`. `PHOTOS.triage` still backs the
          // AI Testing hub hero and the detail rotation, so it stays defined.
          //
          // `c4t-media-dim` takes the cyan down so the frame settles into the
          // ink-950 band instead of glowing out of it — see overrides.css.
          <SiteImage
            src={PHOTOS.robot.src}
            alt={PHOTOS.robot.alt}
            className="c4t-media-dim"
            fill
            ratio="4 / 3"
            sizes="(max-width: 900px) 100vw, 55vw"
          />
        }
      />

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
    justifyContent: 'flex-end',
  },
  { gridColumn: '2 / 4', gridRow: '1' },
  { gridColumn: '2', gridRow: '2' },
  { gridColumn: '3', gridRow: '2' },
] as const

/** The approach section's three photos, in step order. */
/* Step 02 ("Execute") carries the client-supplied `ai.jpg`. `PHOTOS.hardware` is
 * untouched — the Services hub hero and the detail-page rotation both still use
 * it, so only this one slot changed. */
const STEP_PHOTOS = [PHOTOS.scoping, PHOTOS.ai, PHOTOS.dashboard] as const

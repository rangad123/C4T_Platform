import type { Metadata } from 'next'
import {
  Button,
  CtaBanner,
  FeatureCard,
  Hero,
  Section,
  SectionHeader,
  SiteImage,
  StatBlock,
} from '@/components/ds'
import { DeepBand } from '@/components/sections/blocks'
import { CaseStudyStrip } from '@/components/sections/BlogStrips'
import s from '@/components/sections/sections.module.css'
import { loadBlogCollection } from '@/lib/blog/collections'
import { buildMetadata } from '@/lib/seo/metadata'
import {
  ABOUT_PAGE,
  CLOSING_CTA,
  COMPANY_CTAS,
  COMPANY_SECTIONS,
  PHOTOS,
  STAT_BAND,
} from '@/content'

const PATH = '/company/about'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * About, ported from `AboutPage` in `design/site/pages.jsx`.
 *
 * The "why we exist" section is an asymmetric 1fr / 1.2fr split: a short header
 * on the left, two paragraphs of prose on the right. It is the only place on the
 * site with a genuine essay, which is why it gets its own column rather than the
 * 720px header width used everywhere else.
 *
 * The case-study carousel is the same strip as the homepage's: the blog posts
 * filed as case studies, left out when there are none.
 */
export default async function AboutPage() {
  const caseStudies = await loadBlogCollection('case-studies', 6)

  return (
    <>
      <Hero
        className={s.deep}
        tone="inverse"
        eyebrow={ABOUT_PAGE.eyebrow}
        title={ABOUT_PAGE.title}
        description={ABOUT_PAGE.description}
        primaryCta={COMPANY_CTAS.about.primary}
        primaryHref="/contact"
        secondaryCta={COMPANY_CTAS.about.secondary}
        secondaryHref="/contact"
        media={
          <SiteImage
            src={PHOTOS.team.src}
            // Differs from the homepage's alt for the same file: here the
            // photograph stands for the company, not for a workflow.
            alt="The Crowd4Test team reviewing findings together"
            fill
            ratio="4 / 3"
            priority
            sizes="(max-width: 900px) 100vw, 45vw"
          />
        }
      />

      <Section tone="sunken" compact>
        <StatBlock className={s.stats5} stats={STAT_BAND} columns={5} />
      </Section>

      {/* ─── Why we exist ────────────────────────────────────────────────── */}
      <Section>
        <div
          className="c4t-grid-2"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1.2fr',
            gap: 80,
            alignItems: 'start',
          }}
        >
          <SectionHeader {...COMPANY_SECTIONS.aboutWhy} />
          <div>
            {ABOUT_PAGE.why.map((paragraph) => (
              <p
                key={paragraph.slice(0, 32)}
                className="c4t-body-lg"
                style={{ margin: '0 0 20px', color: 'var(--text-secondary)' }}
              >
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      </Section>

      {/* ─── What we believe ─────────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <SectionHeader tone="inverse" {...COMPANY_SECTIONS.aboutBeliefs} />
        <div
          className="c4t-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {ABOUT_PAGE.beliefs.map((belief) => (
            <FeatureCard
              key={belief.title}
              icon={belief.icon}
              title={belief.title}
              description={belief.description}
              tone="inverse"
            />
          ))}
        </div>
      </Section>

      {/* ─── Proof ───────────────────────────────────────────────────────── */}
      {caseStudies.length > 0 ? (
        <Section tone="sunken">
          <SectionHeader
            eyebrow={COMPANY_SECTIONS.aboutProof.eyebrow}
            title={COMPANY_SECTIONS.aboutProof.title}
            actions={
              <Button
                variant="secondary"
                iconRight="arrow-right"
                href={COMPANY_SECTIONS.aboutProof.action.href}
              >
                {COMPANY_SECTIONS.aboutProof.action.label}
              </Button>
            }
          />
          <CaseStudyStrip posts={caseStudies} />
        </Section>
      ) : null}

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

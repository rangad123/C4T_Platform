import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  Badge,
  Button,
  CtaBanner,
  Hero,
  Section,
  SectionHeader,
  StatBlock,
  Tag,
  Testimonial,
} from '@/components/ds'
import { DeepBand } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { DRAFT_METADATA, INCLUDE_DRAFTS } from '@/lib/content-visibility'
import { env } from '@/lib/env'
import { SITE_NAME } from '@/lib/seo/metadata'
import { breadcrumbJsonLd } from '@/lib/seo/structured-data'
import {
  CASE_STUDY_SECTIONS,
  CLOSING_CTA,
  assertPublishedCaseStudiesAreReal,
  getCaseStudy,
  visibleCaseStudies,
} from '@/content'

const PREFIX = '/company/case-studies'

/**
 * A case study: challenge → what we did → result, with an optional client quote.
 * The four-part structure is content.md §12.3's template.
 *
 * ⚠ NO `Article` OR `Review` JSON-LD, EVER, ON THIS TEMPLATE. A case study is a
 * third-party claim with numbers attached; marking it up as a review or a rated
 * item is the fastest route to a manual action, and none of the current entries
 * could substantiate it anyway. Breadcrumbs only.
 *
 * Drafts behave as they do on the blog: routed and badged on preview, absent from
 * production. Every entry is a draft today.
 */
export const dynamicParams = false

export function generateStaticParams() {
  // Fails the build if a study was flipped to published with "00%" still in it.
  // Lived on the index page until that started listing blog posts instead.
  assertPublishedCaseStudiesAreReal()
  return visibleCaseStudies(INCLUDE_DRAFTS).map((study) => ({ slug: study.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const study = getCaseStudy(slug)
  if (!study) return {}

  const url = new URL(`${PREFIX}/${slug}`, env.NEXT_PUBLIC_SITE_URL).toString()
  const title = `${study.client} — ${study.industry} case study`

  return {
    title,
    description: study.headline,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title,
      description: study.headline,
      url,
    },
    twitter: { card: 'summary_large_image', title, description: study.headline },
    ...(study.status === 'draft' ? DRAFT_METADATA : {}),
  }
}

export default async function CaseStudyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const study = getCaseStudy(slug)

  if (!study) notFound()
  if (study.status === 'draft' && !INCLUDE_DRAFTS) notFound()

  const isDraft = study.status === 'draft'

  return (
    <>
      <JsonLd
        schema={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Case studies', path: PREFIX },
          { name: study.client, path: `${PREFIX}/${slug}` },
        ])}
      />

      <Hero
        className={s.deep}
        tone="inverse"
        align="center"
        media={false}
        eyebrow={`${study.industry} · Case study`}
        title={study.headline}
        description={isDraft ? undefined : `How ${study.client} changed the way they release.`}
        primaryCta="Book a demo"
        primaryHref="/contact"
        secondaryCta="Start a pilot"
        secondaryHref="/contact"
      />

      {isDraft ? (
        <Section tone="sunken" compact>
          <Badge tone="warning">Draft — not published</Badge>
          <p
            className="c4t-body-md"
            style={{ margin: '16px 0 0', color: 'var(--text-secondary)', maxWidth: 720 }}
          >
            Placeholder values throughout. content.md §12.3: every metric must trace to delivery
            data and every named client needs written approval before this can go live.
          </p>
        </Section>
      ) : null}

      {/* ─── The result, up front ────────────────────────────────────────── */}
      <Section tone="sunken" compact>
        <StatBlock className={s.stats3} stats={study.results} columns={3} />
      </Section>

      {/* ─── Services used ───────────────────────────────────────────────── */}
      <Section compact>
        <div className="c4t-eyebrow" style={{ color: 'var(--text-brand)' }}>
          Services
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          {study.services.map((service) => (
            <Tag key={service}>{service}</Tag>
          ))}
        </div>
      </Section>

      {/* ─── Challenge ───────────────────────────────────────────────────── */}
      <Section>
        <div style={{ maxWidth: 'var(--container-prose)' }}>
          <SectionHeader {...CASE_STUDY_SECTIONS.challenge} />
          {study.challenge.map((paragraph) => (
            <p
              key={paragraph.slice(0, 40)}
              className="c4t-body-lg"
              style={{ margin: '24px 0 0', color: 'var(--text-secondary)' }}
            >
              {paragraph}
            </p>
          ))}
        </div>
      </Section>

      {/* ─── What we did ─────────────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <div style={{ maxWidth: 'var(--container-prose)' }}>
          <SectionHeader tone="inverse" {...CASE_STUDY_SECTIONS.approach} />
          {study.approach.map((paragraph) => (
            <p
              key={paragraph.slice(0, 40)}
              className="c4t-body-lg"
              style={{ margin: '24px 0 0', color: 'var(--text-inverse-muted)' }}
            >
              {paragraph}
            </p>
          ))}
        </div>
      </Section>

      {/* ─── Quote ───────────────────────────────────────────────────────── */}
      {study.quote ? (
        <Section tone="sunken">
          <div style={{ maxWidth: 860 }}>
            <Testimonial
              variant="feature"
              quote={study.quote.text}
              name={study.quote.name}
              role={study.quote.role}
              company={study.client}
            />
          </div>
        </Section>
      ) : null}

      <Section compact>
        <Button variant="secondary" iconLeft="arrow-left" href={PREFIX}>
          All case studies
        </Button>
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

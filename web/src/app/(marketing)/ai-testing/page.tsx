import type { Metadata } from 'next'
import {
  Button,
  CtaBanner,
  FaqAccordion,
  FeatureCard,
  Hero,
  Section,
  SectionHeader,
  ServiceCard,
  SiteImage,
  StatBlock,
} from '@/components/ds'
import { ChecklistGrid, DeepBand, NumberedRows } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { buildMetadata } from '@/lib/seo/metadata'
import { requireRoute } from '@/lib/seo/routes'
import { breadcrumbFor, faqJsonLd, serviceJsonLd } from '@/lib/seo/structured-data'
import { AI_SERVICES, AI_TESTING_PAGE, CLOSING_CTA, HUB_SECTIONS, PHOTOS } from '@/content'

const PATH = '/ai-testing'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * The AI Testing hub, ported from `AiTestingPage` in `design/site/pages.jsx`.
 *
 * Note the overlap with the AI detail pages is deliberate and NOT shared: the
 * hub's "What we test / Coverage across the AI stack." is a different section
 * from the detail template's "What we cover / The failure modes we test for."
 * The hub argues the category; the detail page scopes one service. Both strings
 * are transcribed, so do not consolidate them into one constant.
 *
 * The nine service cards link to the nine detail pages, so the hub is also the
 * index for its family.
 */
export default function AiTestingHub() {
  return (
    <>
      <JsonLd
        schema={[
          serviceJsonLd(requireRoute(PATH)),
          breadcrumbFor(PATH, 'AI Testing'),
          faqJsonLd(AI_TESTING_PAGE.faqs.map((f) => ({ question: f.q, answer: f.a }))),
        ]}
      />

      <Hero
        className={s.deep}
        tone="inverse"
        eyebrow={AI_TESTING_PAGE.hero.eyebrow}
        title={AI_TESTING_PAGE.hero.title}
        description={AI_TESTING_PAGE.hero.description}
        primaryCta={AI_TESTING_PAGE.hero.primaryCta}
        primaryHref={AI_TESTING_PAGE.hero.primaryHref}
        secondaryCta={AI_TESTING_PAGE.hero.secondaryCta}
        secondaryHref={AI_TESTING_PAGE.hero.secondaryHref}
        media={
          <SiteImage
            src={PHOTOS.triage.src}
            // The hub describes this photo differently from the homepage, where
            // the same file is "engineers triaging test results". Alt text
            // describes the picture in its context.
            alt="Reviewers grading model output against a rubric"
            fill
            ratio="4 / 3"
            priority
            sizes="(max-width: 900px) 100vw, 45vw"
          />
        }
      />

      <Section tone="sunken" compact>
        <StatBlock className={s.stats3} stats={AI_TESTING_PAGE.stats} columns={3} />
      </Section>

      {/* ─── Why it matters ──────────────────────────────────────────────── */}
      <Section>
        <SectionHeader {...HUB_SECTIONS.aiWhy} />
        <div
          className="c4t-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {AI_TESTING_PAGE.why.map((reason) => (
            <FeatureCard
              key={reason.title}
              icon={reason.icon}
              title={reason.title}
              description={reason.description}
              style={{ background: 'var(--surface-sunken)' }}
            />
          ))}
        </div>
      </Section>

      {/* ─── What we test ────────────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <SectionHeader tone="inverse" {...HUB_SECTIONS.aiCoverage} />
        <ChecklistGrid items={AI_TESTING_PAGE.coverage} tone="inverse" />
      </Section>

      {/* ─── How we do it ────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader {...HUB_SECTIONS.aiMethod} />
        <NumberedRows items={AI_TESTING_PAGE.method} />
      </Section>

      {/* ─── The nine services ───────────────────────────────────────────── */}
      <Section>
        <SectionHeader
          eyebrow={HUB_SECTIONS.aiServices.eyebrow}
          title={HUB_SECTIONS.aiServices.title}
          actions={
            <Button
              variant="secondary"
              iconRight="arrow-right"
              href={HUB_SECTIONS.aiServices.action.href}
            >
              {HUB_SECTIONS.aiServices.action.label}
            </Button>
          }
        />
        <div
          className="c4t-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {AI_SERVICES.map((service) => (
            <ServiceCard
              key={service.slug}
              icon={service.icon}
              eyebrow={service.eyebrow}
              title={service.title}
              description={service.description}
              points={service.points}
              badge={service.badge}
              href={`${PATH}/${service.slug}`}
            />
          ))}
        </div>
      </Section>

      {/* ─── FAQ ─────────────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader {...HUB_SECTIONS.faq} />
        <div style={{ marginTop: 40, maxWidth: 860 }}>
          <FaqAccordion
            items={AI_TESTING_PAGE.faqs.map((f) => ({ q: f.q, a: f.a }))}
            defaultOpen={0}
          />
        </div>
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

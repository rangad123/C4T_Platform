import type { Metadata } from 'next'
import {
  CtaBanner,
  FaqAccordion,
  FeatureCard,
  Hero,
  PricingTable,
  Section,
  SectionHeader,
} from '@/components/ds'
import { ChecklistGrid, DeepBand } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { buildMetadata } from '@/lib/seo/metadata'
import { breadcrumbFor, faqJsonLd } from '@/lib/seo/structured-data'
import { CLOSING_CTA, HUB_SECTIONS, PRICING_PAGE, PRICING_TABLE_NOTE } from '@/content'

const PATH = '/pricing'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * Pricing, ported from `PricingPage` in `design/site/pages.jsx`.
 *
 * The hero has no photograph, so it uses the centred layout — that is the
 * prototype's `align={data.photo ? "split" : "center"}` resolved for this page.
 *
 * ⚠ TWO PLACEHOLDERS ARE VISIBLE ON THIS PAGE. The Pilot plan lists "Up to X
 * test hours" and Growth lists "Up to X markets and X languages". Those are
 * literal in content.md, not transcription errors, and they are on the page a
 * buyer reads before asking for a number. They must be resolved with the client
 * before launch. See PRICING_PAGE.plans in content/pages.ts.
 */
export default function PricingPage() {
  return (
    <>
      {/* No `Offer` markup. Every price on this page is a word — "Fixed",
          "Scoped", "Custom" — and schema.org Offer wants a figure and a currency.
          Inventing either to satisfy the schema would publish a machine-readable
          price the company has not agreed to. */}
      <JsonLd
        schema={[
          breadcrumbFor(PATH, 'Pricing'),
          faqJsonLd(PRICING_PAGE.faqs.map((f) => ({ question: f.q, answer: f.a }))),
        ]}
      />

      {/*
        `compact` because this hero carries no media: with `media={false}` the
        band's full 96px bottom padding sat directly on the next section's
        96px top padding, leaving 192px of empty colour between the CTA and
        the first heading. 64px is the system's own compact rhythm.
      */}
      <Hero
        className={s.deep}
        tone="inverse"
        align="center"
        compact
        media={false}
        eyebrow={PRICING_PAGE.hero.eyebrow}
        title={PRICING_PAGE.hero.title}
        description={PRICING_PAGE.hero.description}
        primaryCta={PRICING_PAGE.hero.primaryCta}
        primaryHref={PRICING_PAGE.hero.primaryHref}
        secondaryCta={PRICING_PAGE.hero.secondaryCta}
        secondaryHref={PRICING_PAGE.hero.secondaryHref}
      />

      {/* ─── How pricing works ───────────────────────────────────────────── */}
      {/* Compact on its top edge for the same reason — this is the other half
          of that 192px gap. The sections below keep the full rhythm. */}
      <Section compact>
        <SectionHeader {...HUB_SECTIONS.pricingComponents} />
        <div
          className="c4t-grid-2"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {PRICING_PAGE.components.map((component) => (
            <FeatureCard
              key={component.title}
              icon={component.icon}
              title={component.title}
              description={component.description}
              style={{ background: 'var(--surface-sunken)' }}
            />
          ))}
        </div>
      </Section>

      {/* ─── Plans ───────────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader {...HUB_SECTIONS.pricingPlans} />
        <div style={{ marginTop: 48 }}>
          <PricingTable plans={PRICING_PAGE.plans} note={PRICING_TABLE_NOTE} />
        </div>
      </Section>

      {/* ─── Always included ─────────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <SectionHeader tone="inverse" {...HUB_SECTIONS.pricingAlways} />
        <ChecklistGrid
          items={PRICING_PAGE.always.map((label) => ({ label }))}
          columns={2}
          tone="inverse"
        />
      </Section>

      {/* ─── Pricing FAQ ─────────────────────────────────────────────────── */}
      <Section>
        <SectionHeader {...HUB_SECTIONS.pricingFaq} />
        <div style={{ marginTop: 40, maxWidth: 860 }}>
          <FaqAccordion
            items={PRICING_PAGE.faqs.map((f) => ({ q: f.q, a: f.a }))}
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

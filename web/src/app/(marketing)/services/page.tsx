import type { Metadata } from 'next'
import { CtaBanner, FeatureCard, Hero, Section, SectionHeader, SiteImage } from '@/components/ds'
import { ChecklistGrid, DeepBand } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { buildMetadata } from '@/lib/seo/metadata'
import { requireRoute } from '@/lib/seo/routes'
import { breadcrumbFor, serviceJsonLd } from '@/lib/seo/structured-data'
import { CLOSING_CTA, HUB_SECTIONS, PHOTOS, QA_SERVICES, SERVICES_PAGE } from '@/content'

const PATH = '/services'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * The Services hub, ported from `ServicesPage` in `design/site/pages.jsx`.
 *
 * ⚠ ONE COPY DISCREPANCY, LEFT AS WRITTEN. The section deck says "Fifteen
 * services across web, mobile, API and desktop", and the family does have
 * fifteen detail pages — but only EIGHT of them have homepage cards, and this
 * grid renders those eight. The other seven (mobile, web, API, usability,
 * compatibility, game, IoT/AR-VR) are reachable from the nav, the footer and any
 * detail page's "Related" grid, but not from here.
 *
 * That is how the prototype behaves: it maps `home.qaServices`, not the full
 * fifteen. The count in the sentence is correct about the offering and wrong
 * about the grid under it. Rendering all fifteen would fix the arithmetic and
 * change a designed layout, so it needs a decision rather than a guess — raised
 * with the client. Flip `QA_SERVICES` for the full family list if the answer is
 * "show all fifteen".
 */
export default function ServicesHub() {
  return (
    <>
      {/* No FAQPage: this hub has no FAQ section, and Google requires the
          marked-up questions to be visible on the page. */}
      <JsonLd schema={[serviceJsonLd(requireRoute(PATH)), breadcrumbFor(PATH, 'Services')]} />

      <Hero
        className={s.deep}
        tone="inverse"
        eyebrow={SERVICES_PAGE.hero.eyebrow}
        title={SERVICES_PAGE.hero.title}
        description={SERVICES_PAGE.hero.description}
        primaryCta={SERVICES_PAGE.hero.primaryCta}
        primaryHref={SERVICES_PAGE.hero.primaryHref}
        secondaryCta={SERVICES_PAGE.hero.secondaryCta}
        secondaryHref={SERVICES_PAGE.hero.secondaryHref}
        media={
          <SiteImage
            src={PHOTOS.hardware.src}
            alt={PHOTOS.hardware.alt}
            fill
            ratio="4 / 3"
            priority
            sizes="(max-width: 900px) 100vw, 45vw"
          />
        }
      />

      {/* ─── Choose by need ──────────────────────────────────────────────── */}
      <Section>
        <SectionHeader {...HUB_SECTIONS.servicesChoose} />
        <div
          className="c4t-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {QA_SERVICES.map((service) => (
            <FeatureCard
              key={service.slug}
              icon={service.icon}
              title={service.title}
              description={service.description}
              meta={service.meta}
              href={`${PATH}/${service.slug}`}
              style={{ background: 'var(--surface-sunken)' }}
            />
          ))}
        </div>
      </Section>

      {/* ─── Engagement models ──────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <SectionHeader tone="inverse" {...HUB_SECTIONS.servicesModels} />
        <div
          className="c4t-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {SERVICES_PAGE.models.map((model) => (
            <FeatureCard
              key={model.title}
              icon={model.icon}
              title={model.title}
              description={model.description}
              tone="inverse"
            />
          ))}
        </div>
      </Section>

      {/* ─── Always included ────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader {...HUB_SECTIONS.servicesIncluded} />
        <ChecklistGrid items={SERVICES_PAGE.included.map((label) => ({ label }))} columns={3} />
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

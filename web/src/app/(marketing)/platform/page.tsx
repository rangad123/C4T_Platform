import type { Metadata } from 'next'
import {
  Button,
  CtaBanner,
  FeatureCard,
  Hero,
  Section,
  SectionHeader,
  SiteImage,
  Tag,
} from '@/components/ds'
import { DeepBand, NumberedRows, TickList } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { buildMetadata } from '@/lib/seo/metadata'
import { requireRoute } from '@/lib/seo/routes'
import { breadcrumbFor, serviceJsonLd } from '@/lib/seo/structured-data'
import {
  CLOSING_CTA,
  HUB_SECTIONS,
  INTEGRATIONS,
  PHOTOS,
  PLATFORM_MODULES,
  PLATFORM_PAGE,
} from '@/content'

const PATH = '/platform'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * The Platform hub, ported from `PlatformPage` in `design/site/pages.jsx`.
 *
 * The pipeline table reuses `NumberedRows` with named stages rather than
 * ordinals — "Generate", "Execute", "Triage" — which is why that component's
 * `title` is optional. The middle column stays empty and the three columns keep
 * their alignment down the table.
 *
 * Six of the nine platform detail pages have cards here, for the same reason as
 * the Services hub: the grid maps the homepage list. Device Cloud, Integrations
 * and Security & Compliance are reachable from the nav, the footer and any
 * detail page.
 */
export default function PlatformHub() {
  return (
    <>
      <JsonLd schema={[serviceJsonLd(requireRoute(PATH)), breadcrumbFor(PATH, 'Platform')]} />

      <Hero
        className={s.deep}
        tone="inverse"
        eyebrow={PLATFORM_PAGE.hero.eyebrow}
        title={PLATFORM_PAGE.hero.title}
        description={PLATFORM_PAGE.hero.description}
        primaryCta={PLATFORM_PAGE.hero.primaryCta}
        primaryHref={PLATFORM_PAGE.hero.primaryHref}
        secondaryCta={PLATFORM_PAGE.hero.secondaryCta}
        secondaryHref={PLATFORM_PAGE.hero.secondaryHref}
        media={
          <SiteImage
            src={PHOTOS.dashboard.src}
            alt={PHOTOS.dashboard.alt}
            fill
            ratio="4 / 3"
            priority
            sizes="(max-width: 900px) 100vw, 45vw"
          />
        }
      />

      {/* ─── The pipeline ────────────────────────────────────────────────── */}
      <Section>
        <SectionHeader {...HUB_SECTIONS.platformFlow} />
        <NumberedRows items={PLATFORM_PAGE.flow} />
      </Section>

      {/* ─── Modules ─────────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <SectionHeader
          eyebrow={HUB_SECTIONS.platformModules.eyebrow}
          title={HUB_SECTIONS.platformModules.title}
          actions={
            <Button
              variant="secondary"
              iconRight="arrow-right"
              href={HUB_SECTIONS.platformModules.action.href}
            >
              {HUB_SECTIONS.platformModules.action.label}
            </Button>
          }
        />
        <div
          className="c4t-grid-3"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {PLATFORM_MODULES.map((module) => (
            <FeatureCard
              key={module.slug}
              icon={module.icon}
              title={module.title}
              description={module.description}
              href={`${PATH}/${module.slug}`}
            />
          ))}
        </div>
      </Section>

      {/* ─── Integrations + security ─────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep}>
        <div
          className="c4t-grid-2"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 64,
            alignItems: 'start',
          }}
        >
          <div>
            <SectionHeader
              tone="inverse"
              {...HUB_SECTIONS.platformIntegrations}
              description={PLATFORM_PAGE.stack}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 32 }}>
              {INTEGRATIONS.map((name) => (
                <Tag key={name} tone="inverse">
                  {name}
                </Tag>
              ))}
            </div>
          </div>

          <div>
            <SectionHeader
              tone="inverse"
              eyebrow={HUB_SECTIONS.platformSecurity.eyebrow}
              title={HUB_SECTIONS.platformSecurity.title}
            />
            <TickList items={PLATFORM_PAGE.security} tone="inverse" style={{ marginTop: 32 }} />
            <div style={{ marginTop: 28 }}>
              <Button
                variant="inverse-ghost"
                iconRight="arrow-right"
                href={HUB_SECTIONS.platformSecurity.action.href}
              >
                {HUB_SECTIONS.platformSecurity.action.label}
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

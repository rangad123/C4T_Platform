import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Button,
  CtaBanner,
  FeatureCard,
  Hero,
  Icon,
  Section,
  SectionHeader,
  SiteImage,
} from '@/components/ds'
import { DeepBand } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { buildMetadata } from '@/lib/seo/metadata'
import {
  CAREERS_PAGE,
  CAREERS_PANELS,
  CLOSING_CTA,
  COMPANY_CTAS,
  COMPANY_SECTIONS,
  PHOTOS,
} from '@/content'

const PATH = '/company/careers'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * Careers, ported from `CareersPage` in `design/site/pages.jsx`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE OPEN-ROLES TABLE IS EMPTY, ON PURPOSE.
 *
 * The prototype shipped four rows reading "Role title / Function / Location /
 * Type" and a deck saying "Open roles are pulled from the backend and grouped by
 * function. Replace this placeholder list before launch." content.md says the
 * same: "*(Dynamic list from the backend. Group by function.)*"
 *
 * Both of those are notes to a developer, not copy for a candidate, so neither
 * is rendered. `CAREERS_PAGE.roles` is `[]` and the section shows a one-line
 * empty state instead of a table of the word "Location" repeated four times.
 *
 * That empty state is the ONE string on this site not transcribed from
 * content.md. It is UI text — the same category as a form error — not marketing
 * copy, and there was nothing in the source to transcribe. Replace it if the
 * client prefers different wording, and wire the table to the API when a roles
 * endpoint exists.
 * ──────────────────────────────────────────────────────────────────────────
 */
export default function CareersPage() {
  return (
    <>
      <Hero
        className={s.deep}
        tone="inverse"
        eyebrow={CAREERS_PAGE.eyebrow}
        title={CAREERS_PAGE.title}
        description={CAREERS_PAGE.description}
        primaryCta={COMPANY_CTAS.careers.primary}
        // Anchors down the page rather than to /contact: "See open roles" that
        // opens a demo-booking form would be a bait and switch.
        primaryHref="#open-roles"
        secondaryCta={COMPANY_CTAS.careers.secondary}
        secondaryHref="/contact"
        media={
          <SiteImage
            src={PHOTOS.scoping.src}
            alt="The team working together"
            fill
            ratio="4 / 3"
            priority
            sizes="(max-width: 900px) 100vw, 45vw"
          />
        }
      />

      {/* ─── How we work ─────────────────────────────────────────────────── */}
      <Section>
        <SectionHeader {...COMPANY_SECTIONS.careersHow} />
        <div
          className="c4t-grid-4"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 'var(--space-grid-gap)',
            marginTop: 48,
          }}
        >
          {CAREERS_PAGE.how.map((item) => (
            <FeatureCard
              key={item.title}
              icon={item.icon}
              title={item.title}
              description={item.description}
              style={{ background: 'var(--surface-sunken)' }}
            />
          ))}
        </div>
      </Section>

      {/* ─── Open roles ──────────────────────────────────────────────────── */}
      <Section tone="inverse" className={s.deep} id="open-roles">
        <SectionHeader tone="inverse" {...COMPANY_SECTIONS.careersRoles} />

        {CAREERS_PAGE.roles.length ? (
          <div style={{ marginTop: 48, borderTop: '1px solid var(--border-inverse)' }}>
            {CAREERS_PAGE.roles.map((role) => (
              <Link
                key={role.title}
                href="/contact"
                className={s.roleRow}
                style={{ borderBottom: '1px solid var(--border-inverse)' }}
              >
                <span className="c4t-heading-sm" style={{ color: 'var(--text-inverse)' }}>
                  {role.title}
                </span>
                <span style={ROLE_META}>{role.team}</span>
                <span style={ROLE_META}>
                  {role.location} · {role.type}
                </span>
                <Icon name="arrow-right" size={20} style={{ color: 'var(--text-inverse)' }} />
              </Link>
            ))}
          </div>
        ) : (
          <p
            className="c4t-body-lg"
            style={{ margin: '40px 0 0', color: 'var(--text-inverse-muted)', maxWidth: 560 }}
          >
            {CAREERS_PAGE.emptyState}
          </p>
        )}
      </Section>

      {/* ─── Two closing panels ──────────────────────────────────────────── */}
      <Section tone="sunken">
        <div
          className="c4t-grid-2"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 'var(--space-grid-gap)',
          }}
        >
          <div style={PANEL}>
            <h2 className="c4t-heading-lg" style={{ margin: 0, color: 'var(--text-primary)' }}>
              {CAREERS_PANELS.nothingFits.title}
            </h2>
            <p
              className="c4t-body-md"
              style={{ margin: '12px 0 24px', color: 'var(--text-secondary)' }}
            >
              {CAREERS_PAGE.nothingFits}
            </p>
            <a
              href={`mailto:${CAREERS_PAGE.email}`}
              className="c4t-body-md"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {CAREERS_PAGE.email}
            </a>
          </div>

          <div style={PANEL}>
            <h2 className="c4t-heading-lg" style={{ margin: 0, color: 'var(--text-primary)' }}>
              {CAREERS_PANELS.becomeATester.title}
            </h2>
            <p
              className="c4t-body-md"
              style={{ margin: '12px 0 24px', color: 'var(--text-secondary)' }}
            >
              {CAREERS_PAGE.testerNote}
            </p>
            <Button
              variant="secondary"
              iconRight="arrow-right"
              href={CAREERS_PANELS.becomeATester.href}
            >
              {CAREERS_PANELS.becomeATester.cta}
            </Button>
          </div>
        </div>
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

const ROLE_META = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--type-caption-size)',
  fontWeight: 'var(--fw-medium)',
  color: 'var(--text-inverse-muted)',
} as const

const PANEL = {
  background: 'var(--surface-canvas)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-panel)',
  padding: 40,
} as const

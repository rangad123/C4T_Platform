import type { Metadata } from 'next'
import { CtaBanner, Section, StatBlock } from '@/components/ds'
import { DeepBand } from '@/components/sections/blocks'
import { CaseStudyStrip } from '@/components/sections/BlogStrips'
import s from '@/components/sections/sections.module.css'
import { JsonLd } from '@/components/seo/JsonLd'
import { buildMetadata } from '@/lib/seo/metadata'
import { breadcrumbFor } from '@/lib/seo/structured-data'
import { loadBlogCollection } from '@/lib/blog/collections'
import { CASE_STUDIES_INDEX, CLOSING_CTA, RESULTS } from '@/content'

const PATH = '/company/case-studies'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * The case-study index, ported from `CaseStudiesPage` in `design/site/pages.jsx`.
 *
 * The prototype used the deck carousel here rather than a grid, and kept the
 * three-across results band underneath. Both are preserved — the carousel because
 * a case study is a story you step through rather than scan, and the band because
 * it is the page's summary claim.
 *
 * The studies are blog posts filed as case studies, newest first — the same
 * source as the homepage and About strips. The typed placeholders in
 * `content/case-studies.ts` no longer feed this page: they were drafts holding
 * "00%" and "Case study one", which is why it used to be empty in production.
 */
export default async function CaseStudiesIndexPage() {
  const studies = await loadBlogCollection('case-studies', 12)

  return (
    <>
      <JsonLd schema={breadcrumbFor(PATH, 'Case studies')} />

      <Section tone="inverse" className={s.deep} compact>
        <div className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
          {CASE_STUDIES_INDEX.eyebrow}
        </div>
        <h1
          className="c4t-display-xl"
          style={{
            margin: '20px 0 0',
            color: 'var(--text-inverse)',
            maxWidth: 900,
            textWrap: 'pretty',
          }}
        >
          {CASE_STUDIES_INDEX.title}
        </h1>
        <p
          className="c4t-body-lg"
          style={{ margin: '24px 0 0', color: 'var(--text-inverse-muted)', maxWidth: 620 }}
        >
          {CASE_STUDIES_INDEX.description}
        </p>
      </Section>

      <Section>
        {studies.length ? (
          <CaseStudyStrip posts={studies} />
        ) : (
          <p className="c4t-body-lg" style={{ margin: 0, color: 'var(--text-secondary)' }}>
            {CASE_STUDIES_INDEX.emptyState}
          </p>
        )}
      </Section>

      {/* ⚠ These three outcome figures are unverified — see RESULTS in
          content/home.ts. They render here as they do on the homepage. */}
      <Section tone="sunken" compact>
        <StatBlock className={s.stats3} stats={RESULTS} columns={3} />
      </Section>

      <DeepBand>
        <CtaBanner tone="inverse" style={{ background: 'transparent' }} {...CLOSING_CTA} />
      </DeepBand>
    </>
  )
}

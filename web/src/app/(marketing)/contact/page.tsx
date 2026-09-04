import type { Metadata } from 'next'
import { ContactForm, Section, Tag } from '@/components/ds'
import { NumberedRows } from '@/components/sections/blocks'
import s from '@/components/sections/sections.module.css'
import { buildMetadata } from '@/lib/seo/metadata'
import { CONTACT_FORM, CONTACT_PAGE } from '@/content'
import { submitLead } from './actions'

const PATH = '/contact'

export const metadata: Metadata = buildMetadata(PATH)

/**
 * Contact, ported from `ContactPage` in `design/site/pages.jsx`.
 *
 * One section, one dark band, two columns: the argument on the left, the form on
 * the right. No hero and no closing CTA — the page IS the call to action, and a
 * second "Book a demo" band under a booking form would be absurd. That is the
 * prototype's structure and it is right.
 *
 * The `<h1>` is written out here rather than coming from `Hero`, because the
 * split is asymmetric (copy + agenda + trust chips on one side, a form on the
 * other) and Hero's media slot is not a form.
 */
export default function ContactPage() {
  return (
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
          <div className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
            {CONTACT_PAGE.eyebrow}
          </div>

          <h1
            className="c4t-display-xl"
            style={{ margin: '20px 0 0', color: 'var(--text-inverse)', textWrap: 'pretty' }}
          >
            {CONTACT_PAGE.title}
          </h1>

          <p
            className="c4t-body-lg"
            style={{ margin: '24px 0 0', color: 'var(--text-inverse-muted)', maxWidth: 520 }}
          >
            {CONTACT_PAGE.description}
          </p>

          <div style={{ marginTop: 48 }}>
            <div className="c4t-eyebrow" style={{ color: 'var(--text-inverse-muted)' }}>
              {CONTACT_FORM.agendaLabel}
            </div>
            <div style={{ marginTop: 8 }}>
              <NumberedRows items={CONTACT_PAGE.agenda} tone="inverse" />
            </div>
            <p
              className="c4t-body-sm"
              style={{ margin: '24px 0 0', color: 'var(--text-inverse-muted)' }}
            >
              {CONTACT_PAGE.note}
            </p>
          </div>

          {/* ⚠ The last chip is "ISO 27001 certified" — an audited claim sitting
              directly above a form a buyer is about to fill in. See TRUST in
              content/home.ts. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 40 }}>
            {CONTACT_PAGE.trust.map((claim) => (
              <Tag key={claim} tone="inverse">
                {claim}
              </Tag>
            ))}
          </div>
        </div>

        <ContactForm
          action={submitLead}
          title={CONTACT_FORM.title}
          submitLabel={CONTACT_FORM.submitLabel}
          consentLabel={CONTACT_FORM.consentLabel}
          teamSizes={CONTACT_FORM.teamSizes}
          success={CONTACT_FORM.success}
        />
      </div>
    </Section>
  )
}

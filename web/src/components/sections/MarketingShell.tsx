import Link from 'next/link'
import type { ReactNode } from 'react'
import { SkipLink } from '@/components/a11y/SkipLink'
import { Analytics } from '@/components/analytics/Analytics'
import { CookieBanner } from '@/components/analytics/CookieBanner'
import { Footer, TopNav } from '@/components/ds'
import { JsonLd } from '@/components/seo/JsonLd'
import { ANNOUNCEMENT, FOOTER_COLUMNS, NAV } from '@/content'
import { organizationJsonLd, websiteJsonLd } from '@/lib/seo/structured-data'

/**
 * TopNav + Footer around a page body.
 *
 * WHY THIS IS A COMPONENT AND NOT JUST THE LAYOUT. `app/(marketing)/layout.tsx`
 * wraps everything in the route group, but `app/not-found.tsx` sits at the app
 * root — route-group layouts do not apply to it, and there is no way to make
 * them, because an unmatched URL belongs to no segment. Without this the 404 page
 * renders with no navigation, which is the one page where a visitor most needs
 * it: they arrived somewhere that does not exist and have nothing to click.
 *
 * A Server Component. TopNav carries `"use client"` for its own menu state, but
 * the IA is passed in from here as serialisable data, so the nav content stays on
 * the server and the client bundle only gets the interaction logic.
 */
export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Organization and WebSite go on EVERY page, not just the homepage.
          Google picks whichever page it decides to treat as the entity's
          canonical home, and that is not necessarily `/` — a service page often
          outranks it. Both are static, so the cost is a few hundred bytes. The
          per-page schemas (Service, FAQPage, BreadcrumbList) are emitted by the
          pages themselves. */}
      <JsonLd schema={[organizationJsonLd(), websiteJsonLd()]} />

      <TopNav
        items={NAV}
        announcement={
          <>
            {ANNOUNCEMENT.text}{' '}
            <Link
              href={ANNOUNCEMENT.href}
              style={{ color: 'inherit', fontWeight: 'var(--fw-medium)' }}
            >
              →
            </Link>
          </>
        }
      />
      <SkipLink />
      <main id="main">{children}</main>
      <Footer columns={FOOTER_COLUMNS} />

      {/* Both gate themselves on the client. They deliberately do NOT read the
          cookie here: `cookies()` in this component opted every page on the site
          out of static generation — 56 prerendered routes became 64 dynamic ones.
          See lib/analytics/useConsent.ts. */}
      <CookieBanner />
      <Analytics />
    </>
  )
}

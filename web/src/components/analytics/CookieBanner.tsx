'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button, Checkbox } from '@/components/ds'
import { COOKIE_BANNER } from '@/content'
import { CONSENT_COOKIE, CONSENT_MAX_AGE_SECONDS, serialiseConsent } from '@/lib/analytics/consent'
import { useConsent } from '@/lib/analytics/useConsent'

/**
 * The cookie consent banner. Copy from content.md §3.4, verbatim.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * RENDERED ONLY WHEN THERE IS NO DECISION. It gates itself with `useConsent`,
 * which reads the cookie after mount. Nothing renders until the decision is
 * known, so a returning visitor never sees it flash.
 *
 * NO RELOAD AFTER A CHOICE. An earlier version called `location.reload()`,
 * because the analytics gate lived on the server and had to re-run. Both are
 * client-side now, so writing the cookie and updating local state is enough —
 * the banner disappears and `Analytics` re-evaluates on the same render pass.
 * Reloading the page to dismiss a cookie banner was always a poor experience.
 *
 * ACCESSIBILITY. `role="dialog"` with `aria-modal={false}`: it is a dialog in the
 * sense of asking for a decision, but it must NOT trap focus, because that would
 * make the page unusable for a keyboard user who wants to read the cookie policy
 * before deciding — and that link is inside the banner.
 *
 * ⚠ "Manage preferences" IS NOT A THIRD DISMISSAL. It expands the one real
 * toggle rather than opening a modal with a fake category list. If more
 * categories appear later (marketing, personalisation), they belong in
 * `ConsentState` first — a checkbox that controls nothing is dark-pattern
 * territory.
 *
 * IT RESERVES ITS OWN SPACE. Being `position: fixed`, it sat on top of
 * whatever happened to be at the bottom of the page. On /contact that was the
 * "Book my demo" submit button: the banner covered it and swallowed the
 * click, so a first-time visitor — the only kind who sees this banner — could
 * not book a demo at all. See the effect below.
 * ──────────────────────────────────────────────────────────────────────────
 */
export function CookieBanner() {
  const { decided } = useConsent()
  const [dismissed, setDismissed] = useState(false)
  const [managing, setManaging] = useState(false)
  const [analytics, setAnalytics] = useState(false)
  const bannerRef = useRef<HTMLDivElement>(null)

  const visible = decided === false && !dismissed

  /**
   * Pads the page by exactly the banner's height while it is up, so nothing
   * ends up underneath it.
   *
   * Measured rather than hardcoded because the height is not fixed: the copy
   * wraps differently across breakpoints, and "Manage preferences" expands
   * the banner with two more checkboxes. A `ResizeObserver` keeps the
   * reservation correct through both.
   *
   * The previous inline value is restored on cleanup rather than blanked, so
   * dismissing the banner cannot leave the page with padding it did not start
   * with.
   */
  useEffect(() => {
    const banner = bannerRef.current
    if (!visible || !banner) return

    const previous = document.body.style.paddingBottom
    const apply = () => {
      document.body.style.paddingBottom = `${banner.offsetHeight}px`
    }
    apply()

    const observer = new ResizeObserver(apply)
    observer.observe(banner)
    return () => {
      observer.disconnect()
      document.body.style.paddingBottom = previous
    }
  }, [visible])

  function decide(allowAnalytics: boolean) {
    document.cookie = [
      `${CONSENT_COOKIE}=${serialiseConsent(allowAnalytics)}`,
      'path=/',
      `max-age=${CONSENT_MAX_AGE_SECONDS}`,
      'samesite=lax',
      // Secure only where it can be — localhost has no TLS.
      location.protocol === 'https:' ? 'secure' : '',
    ]
      .filter(Boolean)
      .join('; ')

    setDismissed(true)
  }

  // `decided === null` is pre-hydration — render nothing rather than guess.
  if (!visible) return null

  return (
    <div
      ref={bannerRef}
      role="dialog"
      aria-modal={false}
      aria-labelledby="c4t-consent-title"
      style={{
        position: 'fixed',
        insetInline: 0,
        bottom: 0,
        zIndex: 60,
        background: 'var(--surface-inverse)',
        borderTop: '1px solid var(--border-inverse)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        className="c4t-cta-grid"
        style={{
          maxWidth: 'var(--container-max)',
          margin: '0 auto',
          padding: 'var(--space-6) var(--container-gutter)',
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 'var(--space-7)',
          alignItems: 'center',
        }}
      >
        <div>
          <p
            id="c4t-consent-title"
            className="c4t-heading-sm"
            style={{ margin: 0, color: 'var(--text-inverse)' }}
          >
            {COOKIE_BANNER.title}
          </p>
          <p
            className="c4t-body-sm"
            style={{ margin: '8px 0 0', color: 'var(--text-inverse-muted)', maxWidth: 640 }}
          >
            {COOKIE_BANNER.body}{' '}
            <Link href={COOKIE_BANNER.policyHref} className="c4t-inverse-link">
              {COOKIE_BANNER.policyLabel}
            </Link>
          </p>

          {managing ? (
            <div
              style={{
                marginTop: 'var(--space-5)',
                paddingTop: 'var(--space-5)',
                borderTop: '1px solid var(--border-inverse)',
                display: 'grid',
                gap: 12,
              }}
            >
              {/* Essential is shown disabled and checked rather than hidden, so
                  the visitor can see exactly what the two categories are. */}
              <Checkbox
                checked
                disabled
                tone="inverse"
                label={COOKIE_BANNER.essentialLabel}
                description={COOKIE_BANNER.essentialDescription}
              />
              <Checkbox
                checked={analytics}
                onChange={(e) => setAnalytics(e.currentTarget.checked)}
                tone="inverse"
                label={COOKIE_BANNER.analyticsLabel}
                description={COOKIE_BANNER.analyticsDescription}
              />
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' }}>
          {managing ? (
            <Button variant="inverse" onClick={() => decide(analytics)}>
              {COOKIE_BANNER.save}
            </Button>
          ) : (
            <>
              <Button variant="inverse" onClick={() => decide(true)}>
                {COOKIE_BANNER.acceptAll}
              </Button>
              <Button variant="inverse-ghost" onClick={() => decide(false)}>
                {COOKIE_BANNER.essentialOnly}
              </Button>
              <Button variant="inverse-ghost" onClick={() => setManaging(true)}>
                {COOKIE_BANNER.manage}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'
import { Button } from '@/components/ds/core/Button'

export interface AdminSectionNotReadyProps {
  /** Label that appears in the eyebrow, e.g. "Organisations". */
  section: string
  /** Short paragraph explaining what this section will hold. */
  description: string
  /** Icon shown next to the title. */
  icon?: IconName
  /** The portal's own home route. Default `/app/admin`. */
  homeHref?: string
  /** Shown as the "what works today" link and the back button. Default `'Dashboard'`. */
  homeLabel?: string
}

/**
 * Placeholder for a sidebar-linked section that is not yet built. Lives
 * inside the portal shell so the sidebar / topbar / sign-out controls are
 * all available — only the page contents are unfinished. Shared across
 * portals (admin, customer, ...) via `homeHref`/`homeLabel`, same pattern as
 * `Sidebar`/`Topbar`.
 *
 * Parallel to the portal-not-ready placeholder on the public side, but the
 * audience is different: someone here is not a visitor being told the whole
 * product is on the way. They are a user of an otherwise-working portal
 * being told which one section still needs work.
 */
export function AdminSectionNotReady({
  section,
  description,
  icon,
  homeHref = '/app/admin',
  homeLabel = 'Dashboard',
}: AdminSectionNotReadyProps) {
  return (
    <main
      id="main"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
        maxWidth: 640,
        padding: 'var(--space-11) var(--space-9)',
      }}
    >
      <span
        className="c4t-eyebrow"
        style={{
          color: 'var(--text-muted)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {icon ? <Icon name={icon} size={12} /> : null}
        {section}
      </span>

      <h1
        className="c4t-display-md"
        style={{
          margin: 0,
          textWrap: 'balance',
          color: 'var(--text-primary)',
        }}
      >
        Coming soon
      </h1>

      <p
        style={{
          margin: 0,
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-md-size)',
          lineHeight: 1.6,
        }}
      >
        {description}
      </p>

      <div
        style={{
          marginTop: 'var(--space-3)',
          padding: 'var(--space-5)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          background: 'var(--surface-canvas)',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: 'var(--text-primary)', fontWeight: 'var(--fw-semibold)' }}>
          What works today:
        </strong>{' '}
        <Link href={homeHref} style={{ color: 'var(--text-brand)' }}>
          {homeLabel}
        </Link>
        {' '}and every other sidebar link that isn&rsquo;t marked coming soon. The rest arrive in
        later milestones.
      </div>

      <div>
        <Link href={homeHref}>
          <Button variant="secondary" iconLeft="arrow-left">
            Back to {homeLabel.toLowerCase()}
          </Button>
        </Link>
      </div>
    </main>
  )
}

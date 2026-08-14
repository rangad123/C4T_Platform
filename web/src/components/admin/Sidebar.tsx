import Link from 'next/link'
import { Logo } from '@/components/ds/core/Logo'
import { Icon } from '@/components/ds/core/Icon'
import type { IconName } from '@/components/ds/core/icon-registry'
import type { Role } from '@/lib/api/types'
import styles from './Sidebar.module.css'

export interface SidebarLink {
  href: string
  label: string
  icon: IconName
  /** When true, the link is rendered but disabled — feature not yet built. */
  disabled?: boolean
  /** Restrict to specific roles. Missing = available to anyone on the admin side. */
  roles?: readonly Role[]
}

export interface SidebarSection {
  /** Optional mono-uppercase label rendered above the group. */
  label?: string
  links: readonly SidebarLink[]
}

export interface SidebarProps {
  /** Pathname of the current page, used to derive the active link. */
  pathname: string
  /** Display name of the signed-in user. */
  userName: string
  /** Role of the signed-in user — used for the role chip and section gating. */
  role: Role
  sections: readonly SidebarSection[]
}

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  SUB_ADMIN: 'Sub-admin',
  CUSTOMER: 'Customer',
  TESTER: 'Tester',
  USER: 'User',
}

/**
 * The admin sidebar.
 *
 * Sticky, full-height, single column. Sections are grouped by area so the
 * list stays scannable when it grows. The link's `href` is compared against
 * the current pathname — a leading-segment match for nested routes (so
 * `/app/admin/leads/123` highlights the `/app/admin/leads` link).
 *
 * Disabled links (`disabled: true`) render with the muted style and no
 * pointer events; they exist so the shape of the eventual sidebar is visible
 * while the other admin areas are still being built.
 */
export function Sidebar({ pathname, userName, role, sections }: SidebarProps) {
  return (
    <aside className={styles.sidebar} aria-label="Admin navigation">
      <div className={styles.brand}>
        {/* `href={null}` makes Logo render a plain <span>. Logo links to "/"
            by default, and an anchor inside this anchor is invalid HTML — it
            threw a hydration error and made the whole lockup unclickable. The
            wrapping Link owns the destination; Logo just draws the mark. */}
        <Link href="/app/admin" aria-label="Crowd4Test admin home">
          <Logo size={28} wordmarkSize={14} withWordmark href={null} />
        </Link>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {sections.map((section, sectionIndex) => {
          const visibleLinks = section.links.filter(
            (link) => !link.roles || link.roles.includes(role),
          )
          if (visibleLinks.length === 0) return null

          return (
            <div key={section.label ?? `section-${sectionIndex}`} className={styles.section}>
              {section.label ? <span className={styles.sectionLabel}>{section.label}</span> : null}
              {visibleLinks.map((link) => {
                const isActive =
                  !link.disabled &&
                  (pathname === link.href ||
                    (link.href !== '/app/admin' && pathname.startsWith(`${link.href}/`)))

                const linkClass = [
                  styles.link,
                  isActive ? styles.linkActive : null,
                  link.disabled ? styles.linkDisabled : null,
                ]
                  .filter(Boolean)
                  .join(' ')

                if (link.disabled) {
                  return (
                    <span
                      key={link.href}
                      className={linkClass}
                      aria-disabled="true"
                      title="Coming soon"
                    >
                      <Icon name={link.icon} size={18} className={styles.icon} />
                      <span>{link.label}</span>
                    </span>
                  )
                }

                return (
                  <Link key={link.href} href={link.href} className={linkClass}>
                    <Icon name={link.icon} size={18} className={styles.icon} />
                    <span>{link.label}</span>
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>

      <div className={styles.spacer} />

      <div className={styles.user}>
        <div className={styles.userMeta}>
          <span className={styles.userName}>{userName}</span>
          <span className={styles.userRole}>{ROLE_LABEL[role]}</span>
        </div>
      </div>
    </aside>
  )
}

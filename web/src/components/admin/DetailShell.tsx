import type { ReactNode } from 'react'
import { Topbar } from '@/components/admin/Topbar'

export interface DetailShellProps {
  /** Breadcrumb trail after "Admin". Last entry is the current record. */
  crumbs: readonly { label: string; href?: string }[]
  /** Sidebar group, shown as the eyebrow. */
  eyebrow: string
  /** The record's name. */
  title: string
  /** Reference / email / slug — whatever identifies the record besides its name. */
  subtitle?: ReactNode
  /** Status pills and the like, rendered beside the title. */
  badges?: ReactNode
  /** Primary panels — the left, wider column. */
  children: ReactNode
  /** Secondary panels — the right, narrower column. Omit for a single column. */
  aside?: ReactNode
  /**
   * Sub-navigation for a record with more content than one scroll can hold —
   * pass a `<SectionTabs>`. Rendered between the header and the columns so it
   * reads as belonging to the record, not to the page chrome.
   */
  tabs?: ReactNode
}

/**
 * The shell for an admin detail page.
 *
 * Two columns at desktop width, one below it. The split is by *volume*, not
 * importance: the wide column takes the panels with forms and tables, the
 * narrow one takes metadata and single-control actions. A status control is
 * often the most important thing on the page and still belongs in the aside,
 * because it is one select and would leave two thirds of a wide column empty.
 *
 * Renders the single `<main id="main">` for the page — the admin layout
 * deliberately does not, because the Topbar's nav and sign-out control sit
 * outside the main landmark.
 */
export function DetailShell({
  crumbs,
  eyebrow,
  title,
  subtitle,
  badges,
  children,
  aside,
  tabs,
}: DetailShellProps) {
  return (
    <>
      <Topbar crumbs={crumbs} />

      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-7)',
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
            {eyebrow}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <h1 className="c4t-display-md" style={{ margin: 0 }}>
              {title}
            </h1>
            {badges}
          </div>
          {subtitle ? (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{subtitle}</p>
          ) : null}
        </header>

        {tabs}

        {aside ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.9fr) minmax(280px, 1fr)',
              gap: 'var(--space-6)',
              alignItems: 'start',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {children}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {aside}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {children}
          </div>
        )}
      </main>
    </>
  )
}

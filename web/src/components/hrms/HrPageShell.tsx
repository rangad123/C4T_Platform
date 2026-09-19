import type { ReactNode } from 'react'
import { HrTopbar, type HrCrumb } from './HrTopbar'

export interface HrPageShellProps {
  crumbs: readonly HrCrumb[]
  root: { label: string; href: string }
  eyebrow: string
  title: string
  subtitle?: ReactNode
  /** Status pills and the like, rendered beside the title. */
  badges?: ReactNode
  /** Sub-navigation between the header and the columns — pass an `HrSectionTabs`. */
  tabs?: ReactNode
  /** Secondary column (metadata, single-control actions). Omit for one column. */
  aside?: ReactNode
  children: ReactNode
}

/**
 * The shell for an HRMS module page — structural copy of
 * `components/admin/DetailShell.tsx`'s header/tabs/two-column composition,
 * using `HrTopbar` in place of the platform's `Topbar`. Renders the page's
 * one `<main id="main">`, same reasoning as `DetailShell`: the portal
 * layout's `AppShell` deliberately does not, so the landmark belongs to
 * whichever component actually knows the page structure.
 */
export function HrPageShell({
  crumbs,
  root,
  eyebrow,
  title,
  subtitle,
  badges,
  tabs,
  aside,
  children,
}: HrPageShellProps) {
  return (
    <>
      <HrTopbar crumbs={crumbs} root={root} />

      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          /**
           * A scroll runway under the last panel.
           *
           * Several HRMS pages end in a form — add a holiday, add a salary row
           * — and those pages were barely taller than the viewport, leaving
           * ~30px beneath the final control. A native date picker or select
           * list wants a few hundred, so it ended up jammed against the bottom
           * edge with almost nothing to scroll into. This does not control
           * where the browser draws those popups (nothing in CSS does), but it
           * gives them somewhere to go and the reader somewhere to scroll.
           */
          paddingBottom: 'var(--space-12)',
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

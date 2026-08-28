import type { ReactNode } from 'react'
import styles from './AppShell.module.css'

export interface AppShellProps {
  /** The `<Sidebar>` for this portal. */
  nav: ReactNode
  children: ReactNode
}

/**
 * The frame every portal layout renders: nav rail plus content column.
 *
 * A Server Component — it holds no state, it only owns the geometry. The three
 * layouts (admin, tester, customer) each carried the same two inline style
 * objects, so making the shell responsive meant editing three files and
 * keeping them in step. Now the breakpoint lives in one stylesheet next to the
 * sidebar's own.
 *
 * No `<main>` here, deliberately: each page renders its own `<Topbar>` and
 * `<main id="main">`, because a layout does not re-render on a client-side
 * navigation within its own segment and the breadcrumb has to. See the note in
 * `app/layout.tsx`.
 */
export function AppShell({ nav, children }: AppShellProps) {
  return (
    <div className={styles.shell}>
      {nav}
      <div className={styles.content}>{children}</div>
    </div>
  )
}

import { Spinner } from '@/components/ds/core/Spinner'

/**
 * Next's route-level fallback — shown the instant a navigation into any
 * `/app/admin/*` page starts, for as long as that page's own Server
 * Component data fetch takes. Without this, Next keeps the PREVIOUS page on
 * screen until the new one is ready, which reads as "did my click even
 * register?" on a page with a couple of `Promise.all`-ed fetches.
 *
 * Deliberately bare — just the one shared `Spinner`, no skeleton. The sidebar
 * and topbar are the parent layout, not this file, so they stay put; only
 * the content area shows this while the destination page loads.
 */
export default function AdminLoading() {
  return (
    <main
      id="main"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60dvh',
        padding: 'var(--space-9)',
      }}
    >
      <Spinner size={28} label="Loading" />
    </main>
  )
}

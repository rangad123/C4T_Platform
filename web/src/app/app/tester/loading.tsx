import { Spinner } from '@/components/ds/core/Spinner'

/**
 * Same rationale as admin/loading.tsx — Next's route-level fallback for
 * `/app/tester/*`, shown only for the moment a destination page's own data
 * fetch takes, so a navigation always reads as "in progress" rather than a
 * stale previous page sitting there unexplained.
 */
export default function TesterLoading() {
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

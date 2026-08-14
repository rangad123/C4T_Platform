import type { Metadata } from 'next'
import Link from 'next/link'
import { Topbar } from '@/components/admin/Topbar'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'

export const metadata: Metadata = {
  title: 'Not found',
  robots: { index: false, follow: false },
}

/**
 * 404 inside the admin shell.
 *
 * Sits at `(app)/admin/not-found.tsx` so it inherits the sidebar + topbar
 * layout. The root `app/not-found.tsx` wraps in `MarketingShell` and is the
 * right shape for public 404s but not for an admin visitor who has clicked
 * a stale deep link.
 */
export default function AdminNotFound() {
  return (
    <>
      <Topbar crumbs={[{ label: 'Not found' }]} />
      <main id="main" style={{ padding: 'var(--space-9)' }}>
        <EmptyState
          icon="alert-triangle"
          title="That page doesn't exist"
          description="The link may be stale, or the record may have been removed."
          action={
            <Link href="/app/admin">
              <Button variant="primary">Back to dashboard</Button>
            </Link>
          }
        />
      </main>
    </>
  )
}

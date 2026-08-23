'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'

/**
 * Route-level error boundary for `/app/tester/*`. There is no shared tester
 * layout with a persistent shell (each page renders its own topbar inline,
 * same as `loading.tsx` in this directory), so this replaces the full page
 * rather than just a content area — matching the tradeoff already accepted
 * for the loading fallback next to this file.
 */
export default function TesterError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Tester route error', { digest: error.digest, message: error.message })
  }, [error])

  return (
    <main
      id="main"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-5)',
        minHeight: '60dvh',
        padding: 'var(--space-9)',
        textAlign: 'center',
      }}
    >
      <Icon name="alert-triangle" size={32} color="var(--status-error-fg)" />
      <div>
        <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-2)' }}>
          This page hit a problem
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
          Nothing was saved or changed. Try again, or head back and re-open it.
        </p>
        {error.digest ? (
          <p
            style={{
              marginTop: 'var(--space-4)',
              color: 'var(--text-muted)',
              font: 'var(--fw-medium) var(--type-mono-sm-size)/1.5 var(--font-mono)',
            }}
          >
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </main>
  )
}

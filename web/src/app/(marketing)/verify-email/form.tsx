import Link from 'next/link'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { verifyEmailAction } from '@/lib/auth/actions'

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'This page expects a verification link. Open the one we sent to your email.',
  network: 'Could not reach the verification service. Check your connection and try again.',
  expired: 'This link is invalid, expired, or already used. Sign in and we can send a new one.',
  failed: 'We could not verify your email. Try the link again, or sign in for a new one.',
}

/**
 * The "confirm my email" screen — shared by `/verify-email`, same split as
 * `reset-password/form.tsx`.
 *
 * Shows a button rather than verifying automatically on load: this token is
 * single-use, and mail scanners (Outlook Safe Links, corporate antivirus)
 * fetch a message's links before a person opens them. An automatic verify
 * on GET would let a scanner burn the real reader's token before they ever
 * see the page. The explicit click is the only thing that POSTs.
 */
export default async function VerifyEmailForm({
  searchParams,
}: {
  searchParams?: Promise<{ token?: string; error?: string }>
} = {}) {
  const params = searchParams ? await searchParams : { token: undefined, error: undefined }
  const token = params.token ?? ''
  const error = params.error

  return (
    <>
      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        Verify your email
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          marginBottom: 'var(--space-6)',
        }}
      >
        Confirm this address to finish setting up your Crowd4Test account.
      </p>

      {error && ERROR_MESSAGES[error] ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-5)',
            marginBottom: 'var(--space-6)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            borderRadius: 'var(--radius-input)',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 1.45,
          }}
        >
          <Icon name="alert-triangle" size={18} style={{ flex: 'none', marginTop: 2 }} />
          <span>{ERROR_MESSAGES[error]}</span>
        </div>
      ) : null}

      {token ? (
        <form action={verifyEmailAction}>
          <input type="hidden" name="token" value={token} />
          <SubmitButton
            variant="primary"
            size="lg"
            fullWidth
            iconRight="arrow-right"
            pendingLabel="Verifying…"
          >
            Confirm my email
          </SubmitButton>
        </form>
      ) : (
        <p
          role="alert"
          style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          This page expects a verification link. Open the one we sent to your email.
        </p>
      )}

      <div
        style={{
          marginTop: 'var(--space-6)',
          paddingTop: 'var(--space-5)',
          borderTop: '1px solid var(--border-default)',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        Already verified?{' '}
        <Link
          href="/login"
          replace
          style={{
            color: 'var(--text-brand)',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          Sign in
        </Link>
      </div>
    </>
  )
}

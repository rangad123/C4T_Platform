import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/auth/session'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'

export const metadata: Metadata = {
  title: 'Team invitation',
  robots: { index: false, follow: false },
}

/**
 * `/invitations/[token]` — where a team invitation email lands (§42).
 *
 * Sits in the marketing group because the recipient is very often signed out,
 * and may not have an account at all. The page therefore has three jobs
 * depending on who is looking:
 *
 *   signed out          → send them to sign in, then straight back here
 *   signed in, matching → one button, which accepts
 *   signed in, other    → say so plainly; the API refuses it anyway
 *
 * The token is only ever POSTed to the API, which compares its HASH — this
 * page never learns which organisation it belongs to until acceptance
 * succeeds, so a stranger holding a link learns nothing from loading it.
 *
 * No `<main>` here: `MarketingShell` already renders one. See the note in
 * `app/not-found.tsx`.
 */

/** What the accept endpoint returns once it succeeds. */
interface AcceptedInvitation {
  organisation: { id: string; name: string }
  orgRole: string
}

const OUTCOMES: Record<string, string> = {
  used: 'That invitation has already been used. If you are on the team, sign in and you will see it.',
  withdrawn: 'That invitation was withdrawn by the person who sent it.',
  expired: 'That invitation has expired. Ask whoever invited you to send a new one.',
  mismatch:
    'That invitation was sent to a different email address. Sign in with the address it was sent to, then open the link again.',
  missing: 'That invitation link is not valid. Check you copied the whole link from the email.',
  failed: 'That invitation could not be accepted right now. Try again in a moment.',
}

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ outcome?: string }>
}) {
  const { token } = await params
  const { outcome } = await searchParams
  const user = await getUser()

  /**
   * Accepting is a Server Action rather than something that runs on load: a
   * GET must not change state, and email clients and link scanners routinely
   * fetch URLs before a person ever clicks.
   */
  async function accept() {
    'use server'
    try {
      const result = await serverFetch<AcceptedInvitation>('organisations/invitations/accept', {
        method: 'POST',
        body: { token },
      })
      redirect(`/app/customer/organisation?section=members&notice=joined-${result.organisation.id}`)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const code =
        error.status === 404
          ? 'missing'
          : error.status === 403
            ? 'mismatch'
            : error.status === 409
              ? // The API distinguishes used / withdrawn / expired in its
                // message; the page maps them by reading which one it was.
                error.message.includes('expired')
                ? 'expired'
                : error.message.includes('withdrawn')
                  ? 'withdrawn'
                  : 'used'
              : 'failed'
      redirect(`/invitations/${encodeURIComponent(token)}?outcome=${code}`)
    }
  }

  const problem = outcome ? OUTCOMES[outcome] : undefined

  return (
    <div
      style={{
        padding: 'var(--space-11) var(--space-7)',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          padding: 'var(--space-9)',
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          boxShadow: 'var(--shadow-md)',
          width: '100%',
          maxWidth: 520,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        <h1 className="c4t-display-sm" style={{ margin: 0 }}>
          You have been invited to a team
        </h1>

        {problem ? (
          <p role="alert" style={{ margin: 0, color: 'var(--status-error-fg)' }}>
            {problem}
          </p>
        ) : null}

        {!user ? (
          <>
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              Sign in with the email address this invitation was sent to, and you will come
              straight back here to accept it.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <Button
                href={`/login?next=${encodeURIComponent(`/invitations/${token}`)}`}
                variant="primary"
              >
                Sign in to accept
              </Button>
              <Button
                href={`/register?next=${encodeURIComponent(`/invitations/${token}`)}`}
                variant="secondary"
              >
                Create an account
              </Button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              You are signed in as <strong>{user.email}</strong>. Accepting adds this account to
              the team that invited you.
            </p>
            <form action={accept}>
              <SubmitButton variant="primary" pendingLabel="Joining the team…">
                Accept the invitation
              </SubmitButton>
            </form>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
              Invited under a different address? Sign out and sign back in as that account, then
              open this link again.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

import Link from 'next/link'
import { requireRole, hasPermission } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { Topbar } from '@/components/admin/Topbar'

/**
 * The admin landing — where ADMIN and SUB_ADMIN arrive after sign-in.
 *
 * Slice A ships the leads inbox only, so this is a set of lead counts and one
 * prominent way into the list. It becomes a real dashboard when the other
 * admin areas land.
 *
 * ── Why the counts are not read from /v1/stats/admin
 *
 * That endpoint returns projects, bugs, testers, organisations, users and
 * finance — but NO leads. Rather than add a field to the API for one card,
 * each count comes from the leads list itself: `limit=1` with a status
 * filter, reading `meta.total`. The rows are discarded; only the count is
 * used. Four small queries in parallel, and no API change to keep in sync.
 *
 * If the leads dashboard grows past a handful of tiles, move this into a
 * `GET /v1/leads/stats` that does one `groupBy` instead.
 */

const COUNTED_STATUSES = [
  { status: 'NEW', label: 'New' },
  { status: 'CONTACTED', label: 'In conversation' },
  { status: 'QUALIFIED', label: 'Qualified' },
  { status: 'WON', label: 'Won' },
] as const

async function countLeads(status: string): Promise<number | null> {
  try {
    // `serverFetchPage` keeps `meta`; `serverFetch`/`serverFetchOrNull` unwrap
    // to `data` and discard it, so the total would always read as null here.
    const response = await serverFetchPage<unknown>('leads', {
      query: { status, limit: 1 },
    })
    return response.meta?.total ?? null
  } catch {
    // A tile that cannot be counted shows an em dash, not a zero. See StatCard.
    return null
  }
}

export default async function AdminDashboardPage() {
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])
  const canReadLeads = hasPermission(user, 'lead.read')

  // A sub-admin without lead.read gets no tiles rather than a row of zeros —
  // a zero reads as "no leads", which is a different and misleading claim.
  const counts = canReadLeads
    ? await Promise.all(COUNTED_STATUSES.map((entry) => countLeads(entry.status)))
    : []

  const displayName = user.firstName ?? user.email

  return (
    <>
      <Topbar crumbs={[{ label: 'Dashboard' }]} />

      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          maxWidth: 980,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-9)',
        }}
      >
        <header>
          <p
            className="c4t-eyebrow"
            style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}
          >
            Admin
          </p>
          <h1 className="c4t-display-md" style={{ marginBottom: 'var(--space-4)' }}>
            Welcome back, {displayName}
          </h1>
          <p
            style={{
              color: 'var(--text-secondary)',
              maxWidth: 560,
              fontSize: 'var(--type-body-md-size)',
              margin: 0,
            }}
          >
            Start with the leads inbox — every demo request lands there as it arrives. The rest of
            the admin surface is still being built.
          </p>
        </header>

        {canReadLeads ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-5)',
            }}
          >
            {COUNTED_STATUSES.map((entry, index) => (
              <StatCard
                key={entry.status}
                label={entry.label}
                value={counts[index] ?? null}
                href={`/app/admin/leads?status=${entry.status}`}
              />
            ))}
          </div>
        ) : null}

        <section
          style={{
            padding: 'var(--space-9)',
            background: 'var(--surface-canvas)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
            alignItems: 'flex-start',
          }}
        >
          <h2 className="c4t-heading-md" style={{ margin: 0 }}>
            {canReadLeads ? 'Open the leads inbox' : 'Nothing assigned to you yet'}
          </h2>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            {canReadLeads
              ? 'Triage enquiries from the website contact form: change status, leave notes, and record the ones that convert.'
              : 'Ask an administrator to grant you the permissions for the areas you need.'}
          </p>
          {canReadLeads ? (
            <Link
              href="/app/admin/leads"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                height: 44,
                padding: '0 20px',
                background: 'var(--action-primary-bg)',
                color: 'var(--text-on-brand)',
                borderRadius: 'var(--radius-button)',
                fontWeight: 'var(--fw-medium)',
                textDecoration: 'none',
              }}
            >
              Go to leads inbox
            </Link>
          ) : null}
        </section>
      </main>
    </>
  )
}

function StatCard({ label, value, href }: { label: string; value: number | null; href: string }) {
  return (
    <Link
      href={href}
      className="c4t-card-hover"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 'var(--space-5) var(--space-6)',
        background: 'var(--surface-canvas)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'var(--transition-surface)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 32,
          fontWeight: 'var(--fw-semibold)',
          letterSpacing: '-0.02em',
          color: value === null ? 'var(--text-muted)' : 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {/* An em dash, not 0 — the count is unknown, which is not the same
            claim as "there are none". A real 0 still renders as 0, because
            `??` only falls through on null/undefined. */}
        {value ?? '—'}
      </span>
    </Link>
  )
}

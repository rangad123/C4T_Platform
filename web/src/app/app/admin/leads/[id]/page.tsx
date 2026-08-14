import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Topbar } from '@/components/admin/Topbar'
import { LeadStatusBadge, type LeadStatusValue } from '@/components/admin/LeadStatusBadge'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { requirePermission } from '@/lib/auth/session'
import { serverFetch } from '@/lib/api/server'
import { updateLeadStatus, updateLeadNotes } from '@/lib/leads/actions'
import { formString } from '@/lib/form-data'

/**
 * The lead detail page. `/app/admin/leads/[id]`.
 *
 * Renders the contact card, the original message, and two forms: one for
 * status (a select) and one for internal notes (a textarea). Both submit to
 * Server Actions that write through the API and revalidate the page.
 *
 * `notFound()` is called when the API returns 404 — the page is a real page,
 * not a "missing" page, and Next's `notFound()` returns the closest
 * `not-found.tsx`.
 */

const LEAD_STATUS_VALUES: readonly LeadStatusValue[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'WON',
  'LOST',
  'SPAM',
]

const STATUS_OPTIONS = LEAD_STATUS_VALUES.map((s) => ({
  value: s,
  label: titleCase(s),
}))

interface LeadDetail {
  id: string
  firstName: string
  lastName: string
  email: string
  company: string
  teamSize: string | null
  message: string | null
  marketingConsent: boolean
  status: string
  notes: string | null
  sourcePath: string | null
  convertedOrgId: string | null
  createdAt: string
  updatedAt: string
  convertedOrg: { id: string; name: string } | null
}

function titleCase(value: string): string {
  if (!value) return value
  return value
    .toLowerCase()
    .replace(
      /(^|[\s_-])(\w)/g,
      (_match: string, sep: string, ch: string) => (sep === '_' ? ' ' : sep) + ch.toUpperCase(),
    )
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function saveStatus(formData: FormData): Promise<void> {
  'use server'
  const id = formString(formData, 'id')
  const status = formString(formData, 'status')
  if (!id) return
  await updateLeadStatus(id, status)
}

async function saveNotes(formData: FormData): Promise<void> {
  'use server'
  const id = formString(formData, 'id')
  const notes = formString(formData, 'notes')
  if (!id) return
  await updateLeadNotes(id, notes)
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('lead.read')

  const { id } = await params

  let lead: LeadDetail | null = null
  let loadError: 'forbidden' | 'not_found' | 'unknown' | null = null

  try {
    // `serverFetch` already unwraps the `{ data }` envelope, so this IS the
    // lead — do not reach for `.data` again.
    lead = await serverFetch<LeadDetail>(`leads/${id}`)
  } catch (err) {
    const status =
      err instanceof Error && 'status' in err ? (err as { status?: number }).status : undefined
    if (status === 404) loadError = 'not_found'
    else if (status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError === 'not_found') notFound()
  if (loadError === 'forbidden') {
    return (
      <>
        <Topbar crumbs={[{ label: 'Leads', href: '/app/admin/leads' }, { label: 'Restricted' }]} />
        <main id="main" style={{ padding: 'var(--space-9)' }}>
          <EmptyState
            icon="lock"
            title="You don't have access to this lead"
            description="Ask an administrator to grant you the lead.read permission."
            action={
              <Link href="/app/admin/leads">
                <Button variant="secondary">Back to leads</Button>
              </Link>
            }
          />
        </main>
      </>
    )
  }
  if (loadError === 'unknown' || !lead) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Leads', href: '/app/admin/leads' }, { label: 'Error' }]} />
        <main id="main" style={{ padding: 'var(--space-9)' }}>
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load this lead"
            description="The leads service is unreachable. Refresh in a moment."
            action={
              <Link href="/app/admin/leads">
                <Button variant="secondary">Back to leads</Button>
              </Link>
            }
          />
        </main>
      </>
    )
  }

  const trimmedName = `${lead.firstName} ${lead.lastName}`.trim()
  const fullName = trimmedName.length > 0 ? trimmedName : lead.email

  return (
    <>
      <Topbar crumbs={[{ label: 'Leads', href: '/app/admin/leads' }, { label: fullName }]} />

      <main
        id="main"
        style={{
          padding: 'var(--space-9)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-7)',
          maxWidth: 1100,
        }}
      >
        <div>
          <Link
            href="/app/admin/leads"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
              textDecoration: 'none',
              marginBottom: 'var(--space-4)',
            }}
          >
            <Icon name="arrow-left" size={16} />
            Back to leads
          </Link>

          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <h1 className="c4t-display-md" style={{ margin: 0 }}>
              {fullName}
            </h1>
            <LeadStatusBadge status={lead.status} />
          </header>
          <p style={{ margin: 'var(--space-3) 0 0', color: 'var(--text-secondary)' }}>
            Received {formatDateTime(lead.createdAt)}
            {lead.sourcePath ? ` from ${lead.sourcePath}` : ''}
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)',
            gap: 'var(--space-7)',
            alignItems: 'start',
          }}
        >
          {/* LEFT — message + meta */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-7)' }}>
            <section
              style={{
                padding: 'var(--space-7)',
                background: 'var(--surface-canvas)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-card)',
              }}
            >
              <h2
                className="c4t-heading-md"
                style={{ marginTop: 0, marginBottom: 'var(--space-5)' }}
              >
                Message
              </h2>
              {lead.message ? (
                <p
                  style={{
                    margin: 0,
                    color: 'var(--text-primary)',
                    fontSize: 'var(--type-body-md-size)',
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {lead.message}
                </p>
              ) : (
                <p style={{ margin: 0, color: 'var(--text-muted)' }}>No message was left.</p>
              )}
            </section>

            <section
              style={{
                padding: 'var(--space-7)',
                background: 'var(--surface-canvas)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-card)',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              <DetailRow label="Company" value={lead.company} />
              {lead.teamSize ? <DetailRow label="Team size" value={lead.teamSize} /> : null}
              <DetailRow
                label="Marketing consent"
                value={lead.marketingConsent ? 'Opted in' : 'Declined'}
              />
              <DetailRow label="Updated" value={formatDateTime(lead.updatedAt)} />
              {lead.convertedOrg ? (
                <DetailRow
                  label="Converted to"
                  value={
                    <Link
                      href={`/app/admin/organisations/${lead.convertedOrg.id}`}
                      style={{
                        color: 'var(--text-brand)',
                        textDecoration: 'underline',
                        textUnderlineOffset: 3,
                      }}
                    >
                      {lead.convertedOrg.name}
                    </Link>
                  }
                />
              ) : null}
            </section>
          </div>

          {/* RIGHT — triage: status + notes */}
          <aside style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <form
              action={saveStatus}
              style={{
                padding: 'var(--space-7)',
                background: 'var(--surface-canvas)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
              }}
            >
              <input type="hidden" name="id" value={lead.id} />
              <h2 className="c4t-heading-md" style={{ margin: 0 }}>
                Triage
              </h2>
              <Field label="Status" htmlFor="status">
                <Select
                  id="status"
                  name="status"
                  defaultValue={
                    LEAD_STATUS_VALUES.includes(lead.status as LeadStatusValue)
                      ? lead.status
                      : 'NEW'
                  }
                  options={STATUS_OPTIONS}
                />
              </Field>
              <Button type="submit" variant="primary" fullWidth>
                Save status
              </Button>
            </form>

            <form
              action={saveNotes}
              style={{
                padding: 'var(--space-7)',
                background: 'var(--surface-canvas)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
              }}
            >
              <input type="hidden" name="id" value={lead.id} />
              <h2 className="c4t-heading-md" style={{ margin: 0 }}>
                Internal notes
              </h2>
              <Field
                label="Notes"
                htmlFor="notes"
                hint="Visible to admins only. Never shown to the submitter."
              >
                <Textarea
                  id="notes"
                  name="notes"
                  defaultValue={lead.notes ?? ''}
                  rows={6}
                  placeholder="What did you discuss? When do you follow up?"
                />
              </Field>
              <Button type="submit" variant="secondary" fullWidth>
                Save notes
              </Button>
            </form>
          </aside>
        </div>
      </main>
    </>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--text-primary)', fontSize: 'var(--type-body-sm-size)' }}>
        {value}
      </span>
    </div>
  )
}

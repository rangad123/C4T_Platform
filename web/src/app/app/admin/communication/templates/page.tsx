import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Panel } from '@/components/admin/Panel'
import { Card, CardGrid } from '@/components/admin/Card'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { formatDate, personName } from '@/lib/admin/format'
import { createTemplateAction, deleteTemplateAction } from './actions'
import { CommunicationTabs } from '../tabs'

interface TemplateRow {
  id: string
  name: string
  subject: string | null
  body: string
  createdAt: string
  createdBy: { id: string; firstName: string | null; lastName: string | null } | null
}

const ERROR_MESSAGES: Record<string, string> = {
  duplicate: 'A template with that name already exists — pick a different name.',
  failed: 'Could not save the template. Try again.',
}

/**
 * `/app/admin/communication/templates` — reusable message text.
 *
 * No pagination: the API returns every template in one call, which both
 * consuming composers (announcements, broadcast) need anyway to populate a
 * `<select>` without a second round trip. The list here stays flat for the
 * same reason — template counts in practice are a handful to a few dozen,
 * not thousands.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const errorMessage = params.error ? (ERROR_MESSAGES[params.error] ?? ERROR_MESSAGES.failed) : null

  const templates = await serverFetchOrNull<readonly TemplateRow[]>('communication/templates')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <header>
        <p
          className="c4t-eyebrow"
          style={{ color: 'var(--text-muted)', margin: 0 }}
        >
          Operations
        </p>
        <h1 className="c4t-display-md" style={{ margin: 'var(--space-2) 0 0' }}>
          Message templates
        </h1>
        <p style={{ margin: 'var(--space-3) 0 0', color: 'var(--text-secondary)', maxWidth: '75ch' }}>
          Reusable subject and body pairs. Once created, a template shows up as an &ldquo;Insert a
          template&rdquo; option on both the announcement composer and the tester-broadcast
          composer — picking one fills in the message; it does not lock the fields, so the sender
          can still edit before sending.
        </p>
      </header>

      <CommunicationTabs active="templates" />

      <Panel title="New template">
        {errorMessage ? (
          <p
            role="alert"
            style={{
              margin: '0 0 var(--space-5)',
              padding: 'var(--space-3) var(--space-4)',
              borderRadius: 'var(--radius-input)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            {errorMessage}
          </p>
        ) : null}
        <TrackedForm
          action={createTemplateAction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <Field label="Name" htmlFor="name" required hint="Shown in the template picker — keep it short and specific.">
            <Input id="name" name="name" required maxLength={120} placeholder="Profile Update Request" />
          </Field>
          <Field label="Subject" htmlFor="subject" hint="Optional. Only announcements use a subject line as such — broadcasts use it too, if present.">
            <Input id="subject" name="subject" maxLength={200} />
          </Field>
          <Field label="Body" htmlFor="body" required>
            <Textarea id="body" name="body" rows={6} required maxLength={10000} />
          </Field>
          <div>
            <Button type="submit" variant="primary" iconLeft="plus">
              Save template
            </Button>
          </div>
        </TrackedForm>
      </Panel>

      <Panel title="Existing templates" description={templates ? `${templates.length} saved.` : undefined}>
        {!templates || templates.length === 0 ? (
          <EmptyState
            icon="file-text"
            title="No templates yet"
            description="Save one above and it becomes available in the announcement and broadcast composers."
          />
        ) : (
          /* Templates are peers, and each is short — a grid fits three or four
             across where a stack showed one per screenful. */
          <CardGrid min={320}>
            {templates.map((t) => (
              <Card
                key={t.id}
                title={t.name}
                meta={t.subject ? `Subject: ${t.subject}` : undefined}
                actions={
                  <form action={deleteTemplateAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      style={{ color: 'var(--status-error-fg)' }}
                    >
                      Delete
                    </Button>
                  </form>
                }
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 'var(--type-body-sm-size)',
                    color: 'var(--text-secondary)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {t.body.length > 240 ? `${t.body.slice(0, 240).trimEnd()}…` : t.body}
                </p>
                <div style={{ fontSize: 'var(--type-body-sm-size)', color: 'var(--text-muted)' }}>
                  {t.createdBy ? `Created by ${personName(t.createdBy)}` : 'Created'} on{' '}
                  {formatDate(t.createdAt)}
                </div>
              </Card>
            ))}
          </CardGrid>
        )}
      </Panel>
    </div>
  )
}

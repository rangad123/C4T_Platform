import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Avatar } from '@/components/admin/Avatar'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { serverFetch } from '@/lib/api/server'
import { requirePermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { personName } from '@/lib/admin/format'
import { deleteDraftAction } from '../../broadcast-actions'

/**
 * `/app/admin/communication/messages/[id]` — one message, and what became of
 * it.
 *
 * This is the screen the old Communication section had no way to build. The
 * composer created N private threads and forgot it had done so, so there was
 * nothing to open: no record of the subject and body as sent, no list of who
 * received it, and no way to tell whether anyone had read it. `Broadcast`
 * owns those threads now, so all three questions have answers here.
 *
 * ── ON THE READ COLUMN
 *
 * `readAt` is `ThreadParticipant.lastReadAt` for the recipient's own row —
 * the same timestamp that moves when they open the conversation. It is
 * derived on every read rather than copied onto the recipient row, so it
 * cannot drift from what the tester actually did. "Not opened yet" means
 * exactly that, and nothing on this page claims delivery beyond the fact that
 * a thread exists.
 */

interface Recipient {
  id: string
  threadId: string | null
  failedAt: string | null
  failureReason: string | null
  readAt: string | null
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    avatarFileId: string | null
  }
}

interface BroadcastDetail {
  id: string
  subject: string | null
  body: string
  status: 'DRAFT' | 'SENT'
  sentAt: string | null
  createdAt: string
  updatedAt: string
  sender: { id: string; firstName: string | null; lastName: string | null; email: string }
  template: { id: string; name: string } | null
  readCount: number
  recipients: readonly Recipient[]
}

export default async function MessageDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('communication.read')

  const { id } = await params

  let message: BroadcastDetail
  try {
    message = await serverFetch<BroadcastDetail>(`communication/broadcasts/${id}`)
  } catch (caught) {
    /*
      A 404 here also covers "someone else's draft": the API scopes broadcasts
      to their sender, so another admin's unfinished message is not found
      rather than forbidden. That is the right answer — it is not theirs to
      know about.
    */
    if (caught instanceof ApiError && caught.status === 404) notFound()
    throw caught
  }

  const isDraft = message.status === 'DRAFT'
  const failed = message.recipients.filter((r) => r.failedAt)
  const opened = message.recipients.filter((r) => r.readAt)
  /*
    Length-checked, not `??`. A subject of "   " trims to an empty string,
    which is not nullish — `??` would put a blank heading on the page.
  */
  const trimmedSubject = message.subject?.trim() ?? ''
  const title = trimmedSubject.length > 0 ? trimmedSubject : 'No subject'

  return (
    <DetailShell
      root={{ label: 'Admin', href: '/app/admin' }}
      crumbs={[
        { label: 'Communication', href: '/app/admin/communication' },
        { label: isDraft ? 'Draft' : 'Sent message' },
      ]}
      eyebrow="Operations"
      title={title}
      subtitle={
        isDraft
          ? `Draft · last edited ${formatWhen(message.updatedAt)}`
          : `Sent ${formatWhen(message.sentAt)} by ${personName(message.sender)}`
      }
      badges={<StatusBadge status={message.status} />}
      aside={
        isDraft ? (
          <Panel
            title="This draft"
            description="Nobody has received it yet. Editing reopens the composer with the message and its recipients."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <Button
                href={`/app/admin/communication/compose?draft=${message.id}`}
                variant="primary"
                iconLeft="pencil"
              >
                Edit and send
              </Button>
              {/*
                Arm-then-confirm rather than a modal: discarding a draft can
                only be undone by rewriting it, but it destroys nothing anyone
                else can see, so it does not warrant a typed confirmation.
              */}
              <form action={deleteDraftAction}>
                <input type="hidden" name="broadcastId" value={message.id} />
                <ConfirmSubmit
                  question={`Delete the draft “${title}”? It cannot be recovered.`}
                  confirmLabel="Yes, delete it"
                  iconLeft="trash-2"
                >
                  Delete draft
                </ConfirmSubmit>
              </form>
            </div>
          </Panel>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        <Panel
          title="Message"
          description={
            isDraft
              ? 'Not sent yet. Nobody has received this.'
              : 'Exactly as it was sent. A sent message cannot be edited — it is the record of what went out.'
          }
        >
          <article
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-card)',
              background: 'var(--surface-sunken)',
              padding: 'var(--space-5)',
              maxWidth: '68ch',
            }}
          >
            <strong style={{ display: 'block', marginBottom: 'var(--space-3)' }}>{title}</strong>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{message.body}</p>
          </article>

          <div style={{ marginTop: 'var(--space-5)' }}>
            <DescriptionList
              items={[
                { label: 'Recipients', value: String(message.recipients.length) },
                {
                  label: 'Opened',
                  /*
                    Drafts get an em dash, not a zero: "0 read" on something
                    that was never sent reads as a failure rather than as
                    "not applicable".
                  */
                  value: isDraft ? '—' : `${message.readCount} of ${message.recipients.length}`,
                },
                { label: 'Template', value: message.template?.name ?? '—' },
                { label: 'Created', value: formatWhen(message.createdAt) },
              ]}
            />
          </div>
        </Panel>

        {failed.length > 0 ? (
          <Panel
            title={`${failed.length} could not be delivered`}
            description="These recipients have no conversation for this message. The reason is what the server reported at the time."
          >
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {failed.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) 0',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <Icon name="alert-triangle" size={16} />
                  <span style={{ fontWeight: 'var(--fw-medium)' }}>{personName(r.user)}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {r.failureReason ?? 'No reason recorded.'}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel
          title="Recipients"
          description={
            isDraft
              ? 'Who this will go to when you send it.'
              : `Each has a private conversation with the sender. ${opened.length} of ${message.recipients.length} ${opened.length === 1 ? 'has' : 'have'} opened it.`
          }
        >
          {message.recipients.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              No recipients yet. Open the draft to add some.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {message.recipients.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-4)',
                    padding: 'var(--space-4) 0',
                    borderBottom: '1px solid var(--border-subtle)',
                    flexWrap: 'wrap',
                  }}
                >
                  <Avatar name={personName(r.user)} fileId={r.user.avatarFileId} size="sm" />
                  <span style={{ flex: '1 1 200px', minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 'var(--fw-medium)' }}>
                      {personName(r.user)}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--text-secondary)',
                        fontSize: 'var(--type-body-sm-size)',
                      }}
                    >
                      {r.user.email}
                    </span>
                  </span>

                  <ReadState draft={isDraft} recipient={r} />

                  {r.threadId ? (
                    <Button
                      href={`/app/admin/communication/threads/${r.threadId}`}
                      variant="ghost"
                      size="sm"
                      iconRight="arrow-right"
                    >
                      Open conversation
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </DetailShell>
  )
}

/**
 * One recipient's standing, in the only three states that are real.
 *
 * There is deliberately no "delivered" tick and no "pending" spinner. A
 * thread either exists or it does not, and whether the tester opened it is a
 * timestamp they created themselves.
 */
function ReadState({ draft, recipient }: { draft: boolean; recipient: Recipient }) {
  if (draft) {
    return (
      <Badge tone="neutral" uppercase={false}>
        Not sent
      </Badge>
    )
  }
  if (recipient.failedAt) {
    return (
      <Badge tone="error" uppercase={false}>
        Not delivered
      </Badge>
    )
  }
  if (recipient.readAt) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Badge tone="success" uppercase={false}>
          Opened
        </Badge>
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
          {formatWhen(recipient.readAt)}
        </span>
      </span>
    )
  }
  return (
    <Badge tone="neutral" uppercase={false}>
      Not opened yet
    </Badge>
  )
}

function StatusBadge({ status }: { status: 'DRAFT' | 'SENT' }) {
  return status === 'SENT' ? (
    <Badge tone="success" uppercase={false}>
      Sent
    </Badge>
  ) : (
    <Badge tone="neutral" uppercase={false}>
      Draft
    </Badge>
  )
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

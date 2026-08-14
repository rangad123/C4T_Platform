import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { RoleBadge } from '@/components/admin/StatusBadge'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Field } from '@/components/ds/forms/Field'
import { Textarea } from '@/components/ds/forms/Textarea'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { personName, titleCase } from '@/lib/admin/format'
import { ApiError } from '@/lib/api/types'
import { closeThread, postThreadMessage } from './actions'

const LIST_PATH = '/app/admin/communication/threads'
const MESSAGE_MAX_LENGTH = 5000

interface Person {
  id: string
  firstName: string | null
  lastName: string | null
  role: string
}

interface ThreadMessage {
  id: string
  body: string
  createdAt: string
  editedAt: string | null
  sender: Person
  attachments: readonly {
    file: { id: string; originalName: string; mimeType: string; sizeBytes: number }
  }[]
}

interface ThreadDetail {
  id: string
  type: string
  subject: string | null
  isClosed: boolean
  lastMessageAt: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
  createdBy: Person | null
  participants: readonly { lastReadAt: string | null; user: Person }[]
  _count: { messages: number }
  messages: readonly ThreadMessage[]
}

/** Day and time. A conversation is unreadable without the clock. */
function formatWhen(iso: string | null | undefined): string {
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

/** Attachment sizes, from the API's `sizeBytes` integer. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function threadTitle(thread: Pick<ThreadDetail, 'subject' | 'type'>): string {
  const subject = thread.subject?.trim()
  if (subject) return subject
  return `${titleCase(thread.type)} conversation`
}

/**
 * `/app/admin/communication/threads/[id]` — one conversation, for oversight.
 *
 * DELIBERATELY NOT A CHAT UI. There are no left/right bubbles and no "me"
 * alignment. An admin on this page is usually not a participant, so there is no
 * "me" to align against, and a simulated conversation actively hurts the job:
 * the useful read is a chronological record where every entry states who wrote
 * it, in what role, and when. So each message is an identical bordered block,
 * numbered in order, and the author's role sits next to their name — a customer
 * and a tester saying similar things are different facts.
 *
 * The API marks the thread read for the caller as a side effect of this GET when
 * the caller is a participant, which the participants panel discloses rather
 * than leaving as a surprise.
 */
export default async function ThreadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const { id } = await params

  let thread: ThreadDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    thread = await serverFetch<ThreadDetail>(`communication/threads/${id}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    if (err instanceof ApiError && err.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError !== null || thread === null) {
    return (
      <DetailShell
        crumbs={[
          { label: 'Communication', href: '/app/admin/communication' },
          { label: 'Threads', href: LIST_PATH },
          { label: loadError === 'forbidden' ? 'Restricted' : 'Unavailable' },
        ]}
        eyebrow="Operations"
        title={loadError === 'forbidden' ? 'Restricted conversation' : 'Conversation unavailable'}
      >
        {loadError === 'forbidden' ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this conversation"
            description="Ask an administrator to grant you the communication.read permission."
            action={
              <Button variant="secondary" href={LIST_PATH} iconLeft="arrow-left">
                Back to threads
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load this conversation"
            description="The communication service is unreachable. Refresh in a moment."
            action={
              <Button variant="secondary" href={LIST_PATH} iconLeft="arrow-left">
                Back to threads
              </Button>
            }
          />
        )}
      </DetailShell>
    )
  }

  const messageCount = thread._count.messages
  const title = threadTitle(thread)

  return (
    <DetailShell
      crumbs={[
        { label: 'Communication', href: '/app/admin/communication' },
        { label: 'Threads', href: LIST_PATH },
        { label: title },
      ]}
      eyebrow="Operations"
      title={title}
      subtitle={
        <>
          Started by {personName(thread.createdBy)} on {formatWhen(thread.createdAt)} ·{' '}
          {messageCount} {messageCount === 1 ? 'message' : 'messages'}
        </>
      }
      badges={
        <>
          {thread.isClosed ? (
            <Badge tone="neutral" uppercase={false}>
              Closed
            </Badge>
          ) : (
            <Badge tone="success" dot uppercase={false}>
              Open
            </Badge>
          )}
          <Badge tone="info" uppercase={false}>
            {titleCase(thread.type)}
          </Badge>
        </>
      }
      aside={
        <>
          <Panel title="Conversation">
            <DescriptionList
              items={[
                { label: 'Type', value: titleCase(thread.type) },
                {
                  label: 'Project',
                  value: thread.project
                    ? `${thread.project.reference} · ${thread.project.title}`
                    : null,
                  wide: true,
                },
                { label: 'Started by', value: personName(thread.createdBy) },
                { label: 'Started', value: formatWhen(thread.createdAt) },
                { label: 'Last activity', value: formatWhen(thread.lastMessageAt) },
                { label: 'Messages', value: messageCount },
                { label: 'State', value: thread.isClosed ? 'Closed' : 'Open' },
              ]}
            />
          </Panel>

          <Panel
            title="Participants"
            description="Everyone the API notifies when a message lands. Opening this page marks the thread read for you if you are one of them."
          >
            {thread.participants.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-muted)' }}>No participants remain.</p>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-4)',
                }}
              >
                {thread.participants.map((participant) => (
                  <li
                    key={participant.user.id}
                    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          color: 'var(--text-primary)',
                          fontSize: 'var(--type-body-sm-size)',
                        }}
                      >
                        {personName(participant.user)}
                      </span>
                      <RoleBadge role={participant.user.role} />
                    </span>
                    <span
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: 'var(--type-body-sm-size)',
                      }}
                    >
                      {participant.lastReadAt
                        ? `Last read ${formatWhen(participant.lastReadAt)}`
                        : 'Not read yet'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {thread.isClosed ? null : (
            <Panel
              title="Moderation"
              description="Closing stops every participant from posting. The API has no reopen route, so treat it as final."
            >
              <form action={closeThread}>
                <input type="hidden" name="id" value={thread.id} />
                <Button type="submit" variant="secondary" iconLeft="lock" fullWidth>
                  Close this conversation
                </Button>
              </form>
            </Panel>
          )}
        </>
      }
    >
      <Panel
        title="Messages"
        description="Oldest first, as the API returns them. Deleted messages are not shown."
      >
        {thread.messages.length === 0 ? (
          <EmptyState
            icon="message-square"
            title="Nothing left to read here"
            description="Every message in this conversation has been deleted."
          />
        ) : (
          <ol
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-5)',
            }}
          >
            {thread.messages.map((message, index) => (
              <li key={message.id}>
                <article
                  style={{
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--surface-canvas)',
                    padding: 'var(--space-5)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-4)',
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      flexWrap: 'wrap',
                    }}
                  >
                    {/* An ordinal makes a long thread referenceable — "the reply
                        in 04" — which a bare timestamp does not. */}
                    <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span
                      style={{
                        color: 'var(--text-primary)',
                        fontWeight: 'var(--fw-semibold)',
                        fontSize: 'var(--type-body-sm-size)',
                      }}
                    >
                      {personName(message.sender)}
                    </span>
                    <RoleBadge role={message.sender.role} />
                    <span
                      style={{
                        marginLeft: 'auto',
                        color: 'var(--text-muted)',
                        fontSize: 'var(--type-body-sm-size)',
                      }}
                    >
                      {formatWhen(message.createdAt)}
                      {message.editedAt ? ' · edited' : ''}
                    </span>
                  </header>

                  <p
                    style={{
                      margin: 0,
                      color: 'var(--text-primary)',
                      fontSize: 'var(--type-body-md-size)',
                      lineHeight: 1.55,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {message.body}
                  </p>

                  {message.attachments.length === 0 ? null : (
                    <ul
                      style={{
                        listStyle: 'none',
                        margin: 0,
                        padding: 'var(--space-4) 0 0',
                        borderTop: '1px solid var(--border-subtle)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-3)',
                      }}
                    >
                      {message.attachments.map((attachment) => (
                        <li
                          key={attachment.file.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-3)',
                            color: 'var(--text-secondary)',
                            fontSize: 'var(--type-body-sm-size)',
                          }}
                        >
                          <Icon name="file-text" size={16} />
                          <span style={{ color: 'var(--text-primary)' }}>
                            {attachment.file.originalName}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>
                            {formatBytes(attachment.file.sizeBytes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {thread.isClosed ? (
        <Panel title="This conversation is closed">
          <p
            style={{
              margin: 0,
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-md-size)',
              lineHeight: 1.55,
            }}
          >
            Closed conversations are read-only for everyone, including you. The API has no reopen
            route, so a new thread is the way to carry on this subject.
          </p>
        </Panel>
      ) : (
        <Panel
          title="Add a message"
          description="Posted under your own name and role. Every participant is notified."
        >
          <form
            action={postThreadMessage}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="id" value={thread.id} />
            <Field
              label="Message"
              htmlFor="body"
              required
              hint="Up to 5,000 characters. Participants see it as soon as you post."
            >
              <Textarea
                id="body"
                name="body"
                rows={5}
                required
                maxLength={MESSAGE_MAX_LENGTH}
                placeholder="Answer the question, or record what you did about it."
              />
            </Field>
            <div>
              <Button type="submit" variant="primary" iconLeft="message-square">
                Post message
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </DetailShell>
  )
}

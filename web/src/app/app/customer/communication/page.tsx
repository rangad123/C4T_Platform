import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { InboxList } from '@/components/admin/InboxList'
import { MarkReadOnView } from '@/components/admin/MarkReadOnView'
import {
  buildInboxItems,
  loadBroadcastReads,
  type InboxAnnouncement,
} from '@/lib/communication/inbox'
import { loadList } from '@/lib/admin/list'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { formatDateTime, personName, titleCase } from '@/lib/admin/format'
import { postMessageAction, startThreadAction } from './actions'

const ROOT = { label: 'Customer', href: '/app/customer' }
const BASE = '/app/customer/communication'

/**
 * `/app/customer/communication` — message threads with the platform (§2.2).
 *
 * Unlike announcements, this IS two-way for a customer: `thread.read` and
 * `thread.post` both grant to `thread:participant`, and a customer may start a
 * thread on any project they can already see. So the page reads and writes.
 *
 * ── ON PARTICIPANTS
 *
 * Starting a thread needs participant ids, and a client has no way to know
 * them — nor should they be able to type arbitrary ids and learn which exist.
 * They come from the chosen project's own `contacts`, which the API decides:
 * its managers and the organisation's owners. When a project has none, the
 * form says so rather than failing on submit.
 */

const NOTICES: Record<string, NoticeCopy> = {
  sent: { tone: 'success', message: 'Your reply has been posted.' },
  started: { tone: 'success', message: 'Your conversation has been started.' },
  empty: { tone: 'warning', message: 'Write a message before sending.' },
  'need-project': { tone: 'warning', message: 'Choose which project this is about.' },
  'no-contacts': {
    tone: 'warning',
    message: 'That project has nobody assigned to talk to yet. Try another, or contact support.',
  },
  'no-access': { tone: 'error', message: 'You are not part of that conversation.' },
  failed: { tone: 'error', message: 'That could not be sent. Try again in a moment.' },
}

interface ThreadRow {
  id: string
  type: string
  subject: string | null
  isClosed: boolean
  lastMessageAt: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
  createdBy: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  participants: readonly {
    /**
     * When this participant last opened the thread. The API has always sent
     * it; this shape never declared it, so the list could not tell a thread
     * with something new in it from one already read.
     */
    lastReadAt: string | null
    user: { id: string; firstName: string | null; lastName: string | null; role: string }
  }[]
  _count: { messages: number }
}

interface ThreadDetail extends ThreadRow {
  messages: readonly {
    id: string
    body: string
    createdAt: string
    sender: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  }[]
}

interface ProjectOption {
  id: string
  reference: string
  title: string
}

interface ProjectDetailContacts {
  contacts: readonly {
    id: string
    firstName: string | null
    lastName: string | null
    role: string
  }[]
}

export default async function CustomerCommunicationPage({
  searchParams,
}: {
  searchParams: Promise<{
    thread?: string
    announcement?: string
    projectId?: string
    notice?: string
  }>
}) {
  const viewer = await requireRole(['CUSTOMER'])
  const { thread: threadId, announcement: announcementId, projectId, notice } = await searchParams

  const [threadsResult, projectsResult, announcementsResult, reads] = await Promise.all([
    loadList<ThreadRow>('communication/threads', {
      page: 1,
      limit: 50,
      query: { includeClosed: 'true' },
    }),
    loadList<ProjectOption>('projects', {
      page: 1,
      limit: 100,
      query: { sort: 'title', order: 'asc' },
    }),
    /**
     * Platform-wide announcements share this inbox — see `buildInboxItems`
     * for why. Project-scoped ones are filtered out there: they belong to
     * the build they are about, not to a flat list.
     */
    loadList<InboxAnnouncement>('communication/announcements', { page: 1, limit: 50 }),
    loadBroadcastReads(),
  ])

  const threads = 'items' in threadsResult ? threadsResult.items : []
  const projects = 'items' in projectsResult ? projectsResult.items : []
  const announcements = 'items' in announcementsResult ? announcementsResult.items : []

  const inboxItems = buildInboxItems({
    basePath: BASE,
    viewerId: viewer.id,
    threads,
    announcements,
    reads,
  })

  const openAnnouncement = announcementId
    ? (announcements.find((a) => a.id === announcementId) ?? null)
    : null

  /**
   * The open thread, and the contacts for whichever project a new thread would
   * be about. Both are only read when they are actually needed.
   */
  const [openThread, projectContacts] = await Promise.all([
    threadId
      ? serverFetchOrNull<ThreadDetail>(`communication/threads/${threadId}`)
      : Promise.resolve(null),
    projectId
      ? serverFetchOrNull<ProjectDetailContacts>(`projects/${projectId}`)
      : Promise.resolve(null),
  ])

  const contacts = projectContacts?.contacts ?? []

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Communication' }]}
      eyebrow="Operations"
      title="Communication"
      subtitle="Conversations with the Crowd4Test team about your projects."
    >
      <Notice code={notice} notices={NOTICES} />

      {/* ── An open announcement ─────────────────────────────────────────
          A broadcast has no reply, so it is a panel and not a conversation.
          Opening it is what marks it read — see `MarkReadOnView` for why the
          write happens on display rather than during the render. */}
      {openAnnouncement ? (
        <>
          <MarkReadOnView
            notificationId={reads.notificationIdFor.get(openAnnouncement.id) ?? null}
          />
          <Panel
            title={openAnnouncement.title}
            description={`From ${
              openAnnouncement.author ? personName(openAnnouncement.author) : 'Crowd4Test'
            }${
              openAnnouncement.publishedAt
                ? ` · ${formatDateTime(openAnnouncement.publishedAt)}`
                : ''
            }`}
            actions={
              <Button href={BASE} variant="secondary" size="sm" iconLeft="arrow-left">
                Back to inbox
              </Button>
            }
          >
            <p style={{ margin: 0, whiteSpace: 'pre-wrap', maxWidth: '70ch' }}>
              {openAnnouncement.body}
            </p>
          </Panel>
        </>
      ) : null}

      {/* ── An open conversation ──────────────────────────────────────── */}
      {threadId ? (
        openThread === null ? (
          <Panel title="Conversation">
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              That conversation could not be opened. It may not be one you are part of.
            </p>
          </Panel>
        ) : (
          <Panel
            title={openThread.subject ?? 'Conversation'}
            description={
              openThread.project
                ? `${openThread.project.reference} · ${openThread.project.title}`
                : titleCase(openThread.type)
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <div>
                <Button href={BASE} variant="ghost" size="sm" iconLeft="arrow-left">
                  All conversations
                </Button>
              </div>

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
                {openThread.messages.map((message) => (
                  <li
                    key={message.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-2)',
                      padding: 'var(--space-4)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-card)',
                      background: 'var(--surface-canvas)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 'var(--space-3)',
                        flexWrap: 'wrap',
                        fontSize: 'var(--type-body-sm-size)',
                      }}
                    >
                      <span
                        style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-primary)' }}
                      >
                        {message.sender ? personName(message.sender) : 'Crowd4Test'}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {formatDateTime(message.createdAt)}
                      </span>
                    </div>
                    <p
                      style={{ margin: 0, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
                    >
                      {message.body}
                    </p>
                  </li>
                ))}
              </ul>

              {openThread.isClosed ? (
                <p
                  style={{
                    margin: 0,
                    color: 'var(--text-muted)',
                    fontSize: 'var(--type-body-sm-size)',
                  }}
                >
                  This conversation has been closed. Start a new one if you need to follow up.
                </p>
              ) : (
                <form
                  action={postMessageAction}
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
                >
                  <input type="hidden" name="threadId" value={openThread.id} />
                  <Field label="Reply" htmlFor="body" required>
                    <Textarea id="body" name="body" rows={4} required maxLength={5000} />
                  </Field>
                  <div>
                    <SubmitButton variant="primary" pendingLabel="Sending…">
                      Send reply
                    </SubmitButton>
                  </div>
                </form>
              )}
            </div>
          </Panel>
        )
      ) : (
        <>
          {/* ── The list ───────────────────────────────────────────────── */}
          <Panel
            title="Inbox"
            description="Conversations and platform announcements, newest first."
            flush={inboxItems.length > 0}
          >
            {inboxItems.length === 0 ? (
              <EmptyState
                icon="message-square"
                title="Nothing here yet"
                description="Conversations you start and announcements we send both arrive here."
              />
            ) : (
              <InboxList items={inboxItems} />
            )}
          </Panel>

          {/* ── Starting one ───────────────────────────────────────────── */}
          <Panel
            title="Start a conversation"
            description="Pick the project it is about, and the team working on it is included automatically."
          >
            {projects.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                You need a project before you can start a conversation about one.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
                {/* Choosing the project is its own GET so the contacts can be
                    loaded before the message is written — a form that only
                    discovered "nobody to send this to" on submit would lose
                    what the person had typed. */}
                <form
                  method="get"
                  action={BASE}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-4)',
                    alignItems: 'flex-end',
                    flexWrap: 'wrap',
                  }}
                >
                  <Field
                    label="About which project?"
                    htmlFor="projectId"
                    style={{ flex: '2 1 260px' }}
                  >
                    <Select
                      id="projectId"
                      name="projectId"
                      defaultValue={projectId ?? ''}
                      options={[
                        { value: '', label: 'Select a project' },
                        ...projects.map((p) => ({
                          value: p.id,
                          label: `${p.reference} · ${p.title}`,
                        })),
                      ]}
                    />
                  </Field>
                  <SubmitButton variant="secondary" pendingLabel="Loading…">
                    Continue
                  </SubmitButton>
                </form>

                {projectId ? (
                  contacts.length === 0 ? (
                    <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                      That project has nobody assigned to talk to yet. Choose another, or contact
                      support directly.
                    </p>
                  ) : (
                    <form
                      action={startThreadAction}
                      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
                    >
                      <input type="hidden" name="projectId" value={projectId} />
                      {contacts.map((c) => (
                        <input key={c.id} type="hidden" name="participantIds" value={c.id} />
                      ))}

                      <p
                        style={{
                          margin: 0,
                          color: 'var(--text-muted)',
                          fontSize: 'var(--type-body-sm-size)',
                        }}
                      >
                        Goes to {contacts.map((c) => personName(c)).join(', ')}.
                      </p>

                      <Field label="Subject" htmlFor="subject">
                        <Input id="subject" name="subject" maxLength={200} placeholder="Optional" />
                      </Field>
                      <Field label="Message" htmlFor="message" required>
                        <Textarea id="message" name="message" rows={5} required maxLength={5000} />
                      </Field>
                      <div>
                        <SubmitButton variant="primary" pendingLabel="Starting…">
                          Start the conversation
                        </SubmitButton>
                      </div>
                    </form>
                  )
                ) : null}
              </div>
            )}
          </Panel>
        </>
      )}
    </DetailShell>
  )
}

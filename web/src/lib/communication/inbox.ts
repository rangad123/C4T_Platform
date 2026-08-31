import { serverFetchPage } from '@/lib/api/server'
import type { InboxItem } from '@/components/admin/InboxList'
import { personName } from '@/lib/admin/format'

/**
 * The Communications inbox: conversations and broadcasts, in one list.
 *
 * ── Why two sources in one inbox
 *
 * A `Thread` is a conversation with someone; a platform-wide `Announcement`
 * is a broadcast from us. They are different records, but to the person
 * reading them they are the same thing — something arrived, it has a subject
 * and a sender, and it is either read or not. Splitting them across a global
 * feed and an inbox meant checking two places for the same kind of news.
 *
 * Announcements that belong to a PROJECT are deliberately absent: those are
 * read at Project → Build → Announcements, where the build they are about is
 * on screen. Only the platform-wide ones — the ones with nowhere else to
 * live — surface here.
 *
 * ── Where read state comes from
 *
 * Threads carry it themselves: `ThreadParticipant.lastReadAt` against the
 * thread's last message. Announcements have no read column at all, and need
 * none — publishing one creates a `Notification` per recipient, so the
 * reader's own notification row IS the read state. One system, as the spec
 * asks, and no new table.
 */

/** A thread as the list endpoint returns it. */
export interface InboxThread {
  id: string
  type: string
  subject: string | null
  isClosed: boolean
  lastMessageAt: string | null
  createdAt: string
  project: { id: string; reference: string; title: string } | null
  createdBy: { id: string; firstName: string | null; lastName: string | null } | null
  participants: readonly {
    lastReadAt: string | null
    user: { id: string; firstName: string | null; lastName: string | null }
  }[]
  _count: { messages: number }
}

/** An announcement as the list endpoint returns it. */
export interface InboxAnnouncement {
  id: string
  title: string
  body: string
  projectId: string | null
  buildId: string | null
  project: { id: string; reference: string; title: string } | null
  build: { id: string; name: string } | null
  publishedAt: string | null
  author: { id: string; firstName: string | null; lastName: string | null } | null
}

interface NotificationRow {
  id: string
  type: string
  readAt: string | null
  metadata: { announcementId?: string } | null
}

export interface BroadcastReads {
  /** Announcement ids this viewer has not read yet. */
  unreadIds: ReadonlySet<string>
  /** announcementId → the notification carrying it, so it can be marked read. */
  notificationIdFor: ReadonlyMap<string, string>
}

/**
 * The viewer's unread announcement notifications.
 *
 * Best-effort on purpose: if this fails the inbox still lists everything, it
 * just cannot say what is new. An inbox missing its bold text is a much
 * smaller problem than an inbox that failed to load.
 */
export async function loadBroadcastReads(): Promise<BroadcastReads> {
  const unreadIds = new Set<string>()
  const notificationIdFor = new Map<string, string>()
  try {
    const { data } = await serverFetchPage<NotificationRow>('notifications', {
      query: { page: 1, limit: 100, unreadOnly: 'true' },
    })
    for (const row of data) {
      const id = row.type === 'ANNOUNCEMENT' ? row.metadata?.announcementId : undefined
      if (!id) continue
      unreadIds.add(id)
      notificationIdFor.set(id, row.id)
    }
  } catch {
    // Falls through to an empty set: nothing marked unread, everything listed.
  }
  return { unreadIds, notificationIdFor }
}

/** First line of a body, for the preview beside a subject. */
function preview(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

/**
 * Merges threads and broadcasts into one list, newest first.
 *
 * Sorted on the time each thing last had something new — a thread's last
 * message, an announcement's publication — because that is the order an
 * inbox is read in, and it is the only ordering under which two sources can
 * sit together without one of them looking stale.
 */
export function buildInboxItems(options: {
  basePath: string
  viewerId: string
  threads: readonly InboxThread[]
  announcements: readonly InboxAnnouncement[]
  reads: BroadcastReads
}): InboxItem[] {
  const { basePath, viewerId, threads, announcements, reads } = options

  const threadItems: InboxItem[] = threads.map((thread) => {
    const mine = thread.participants.find((p) => p.user.id === viewerId)
    const last = thread.lastMessageAt
    /**
     * Unread when something arrived after this viewer last looked. A thread
     * they have never opened counts as unread only if it actually has a
     * message — an empty one has nothing to have missed.
     */
    const unread = Boolean(
      last && (!mine?.lastReadAt || new Date(mine.lastReadAt) < new Date(last)),
    )
    const other = thread.participants.find((p) => p.user.id !== viewerId)?.user ?? thread.createdBy

    return {
      id: `thread-${thread.id}`,
      href: `${basePath}?thread=${thread.id}`,
      sender: other ? personName(other) : 'Crowd4Test',
      subject: thread.subject ?? 'Conversation',
      preview: `${thread._count.messages} message${thread._count.messages === 1 ? '' : 's'}${
        thread.isClosed ? ' · closed' : ''
      }`,
      timestamp: last ?? thread.createdAt,
      unread,
      tag: thread.project ? thread.project.reference : undefined,
    }
  })

  const broadcastItems: InboxItem[] = announcements
    .filter((a) => a.projectId === null)
    .map((a) => ({
      id: `announcement-${a.id}`,
      href: `${basePath}?announcement=${a.id}`,
      sender: a.author ? personName(a.author) : 'Crowd4Test',
      subject: a.title,
      preview: preview(a.body),
      timestamp: a.publishedAt,
      unread: reads.unreadIds.has(a.id),
      tag: 'Announcement',
    }))

  return [...threadItems, ...broadcastItems].sort(
    (a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime(),
  )
}

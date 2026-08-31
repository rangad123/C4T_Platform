import Link from 'next/link'
import type { ReactNode } from 'react'
import styles from './InboxList.module.css'
import { formatInboxTime } from '@/lib/admin/format'

export interface InboxItem {
  /** Stable key. Not necessarily the underlying record's id. */
  id: string
  /** Where the row opens. */
  href: string
  /** Who it is from — a person, or the platform for a broadcast. */
  sender: string
  /** The one thing the row is about. */
  subject: string
  /** First line of the body. Truncated to one line beside the subject. */
  preview?: string | null
  /** ISO timestamp. Rendered relative for recent items. */
  timestamp: string | null
  /** Drives the weight and the dot. */
  unread?: boolean
  /**
   * A short scope marker shown before the subject — a project reference, or
   * the kind of thing this is. Kept to a word or two; anything longer eats
   * the subject it is meant to qualify.
   */
  tag?: ReactNode
}

/**
 * The message list shared by Communications and Announcements, in both
 * portals.
 *
 * ── Why one component
 *
 * These are four lists of the same shape — someone sent something, it has a
 * subject and a first line, it arrived at a time, and you have either read it
 * or not. They had drifted into four different layouts of bordered cards, so
 * the same information sat in a different place on each page and none of them
 * could be scanned. One row definition means a reader learns it once.
 *
 * ── Why it looks like this
 *
 * Sender in a fixed column so subjects align down the page; subject and
 * preview on one line so a screenful is a screenful of messages rather than
 * of padding; the timestamp right-aligned where the eye can find it without
 * reading the row. Unread is carried by weight rather than a tinted row,
 * which reads as "selected" instead of "new".
 *
 * A Server Component: every consumer already knows the read state at render,
 * so there is nothing here for the client to do.
 */
export function InboxList({ items }: { items: readonly InboxItem[] }) {
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={item.href}
            className={`${styles.row} ${item.unread ? styles.unread : ''}`}
            aria-label={item.unread ? `Unread: ${item.subject}` : item.subject}
          >
            {/* Always rendered, so read and unread rows share a left edge. */}
            <span aria-hidden="true">{item.unread ? <span className={styles.dot} /> : null}</span>

            <span className={styles.sender}>{item.sender}</span>

            <span className={styles.line}>
              {item.tag ? <span className={`c4t-eyebrow ${styles.tag}`}>{item.tag}</span> : null}
              <span className={styles.subject}>{item.subject}</span>
              {item.preview ? <span className={styles.preview}>{item.preview}</span> : null}
            </span>

            <span className={styles.time}>{formatInboxTime(item.timestamp)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

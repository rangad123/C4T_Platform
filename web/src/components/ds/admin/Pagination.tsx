import Link from 'next/link'
import { Icon } from '@/components/ds/core/Icon'
import styles from './Pagination.module.css'

export interface PaginationProps {
  /** Current page (1-based). */
  page: number
  totalPages: number
  total: number
  /** Page size. Used only for the summary label. */
  limit: number
  /**
   * Builds the href for a given page number. Receives the page and should
   * return a same-origin URL preserving any unrelated query params.
   */
  hrefFor: (page: number) => string
}

/**
 * URL-driven pagination. Prev / Next with a numeric summary in between. No
 * page-jumper — admins read lists top-to-bottom, the rare "skip to page 47"
 * is a future feature, and a single numeric input complicates a11y for almost
 * no one.
 */
export function Pagination({ page, totalPages, total, limit, hrefFor }: PaginationProps) {
  const hasPrev = page > 1
  const hasNext = page < totalPages
  const start = total === 0 ? 0 : (page - 1) * limit + 1
  const end = Math.min(page * limit, total)

  return (
    <nav className={styles.wrapper} aria-label="Pagination">
      <span className={styles.summary}>
        {total === 0 ? 'No results' : `${start}–${end} of ${total}`}
      </span>
      <div className={styles.controls}>
        <Link
          href={hrefFor(Math.max(1, page - 1))}
          aria-disabled={!hasPrev}
          className={styles.button}
          tabIndex={hasPrev ? 0 : -1}
        >
          <Icon name="chevron-left" size={16} />
          Previous
        </Link>
        <span className={styles.summary} aria-hidden="true">
          Page {page} of {Math.max(1, totalPages)}
        </span>
        <Link
          href={hrefFor(Math.min(totalPages, page + 1))}
          aria-disabled={!hasNext}
          className={styles.button}
          tabIndex={hasNext ? 0 : -1}
        >
          Next
          <Icon name="chevron-right" size={16} />
        </Link>
      </div>
    </nav>
  )
}

import { formatDate } from '@/lib/admin/format'

export interface AttachmentIdentityProps {
  /** The file's name as the reporter uploaded it. */
  originalName: string
  mimeType: string
  sizeBytes: number
  /** When the attachment was filed, not when the file was made. */
  createdAt: string
  /**
   * Signed, short-lived URL — or `null` when the bytes are not in the bucket.
   *
   * The API returns null rather than a URL it knows will fail; see the note on
   * `getBug`'s attachment mapping in `api/src/modules/bugs/bugs.service.ts`.
   */
  downloadUrl: string | null
}

/**
 * An attachment's name and metadata line, on every bug detail page.
 *
 * ── WHY A COMPONENT AND NOT THREE COPIES
 *
 * Admin, customer and tester each rendered this markup identically, which is
 * how all three came to offer a download link for a file that no longer
 * exists. A rule about what to show when the bytes are gone is worth stating
 * once.
 *
 * ── WHY A MISSING FILE IS STILL A ROW
 *
 * 4,377 of the migrated screenshots were pruned from the old host years before
 * the migration ran. The attachment row is the only surviving evidence that a
 * tester filed one, so it stays — but it stays as a fact, not as a link.
 * Clicking the old link reached S3, which, lacking `s3:ListBucket` on this
 * bucket, reported the missing object as `AccessDenied` and handed the reader
 * raw XML about an IAM role. Saying "no longer available" is both true and
 * useful; that was neither.
 *
 * The byte count is dropped in that case. "0 B" is what the database holds
 * because nothing was ever uploaded, and printing it invites the reader to
 * believe an empty file was attached.
 */
export function AttachmentIdentity({
  originalName,
  mimeType,
  sizeBytes,
  createdAt,
  downloadUrl,
}: AttachmentIdentityProps) {
  const meta = downloadUrl
    ? `${formatBytes(sizeBytes)} · ${mimeType} · added ${formatDate(createdAt)}`
    : `${mimeType} · added ${formatDate(createdAt)}`

  /*
    A fragment, not a wrapper: each page already has the flex column that holds
    this and the caption below it, and those columns differ slightly in the
    surrounding layout. Owning the rule about a missing file does not require
    owning the box it sits in.
  */
  return (
    <>
      {downloadUrl ? (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            color: 'var(--text-brand)',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
            wordBreak: 'break-word',
          }}
        >
          {originalName}
        </a>
      ) : (
        <span style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
          {originalName}
        </span>
      )}
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
        {meta}
      </span>
      {downloadUrl ? null : (
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
          This file is no longer available — it was not among the files recovered from the previous
          platform.
        </span>
      )}
    </>
  )
}

/** Bytes in the largest unit that keeps the number readable. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

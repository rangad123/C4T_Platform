import { Icon } from '@/components/ds/core/Icon'

export interface DownloadLinkProps {
  /** `FileObject` id — the route resolves it to a signed URL server-side. */
  fileId: string
  /** What to show. Usually the file's original name. */
  name: string
  /**
   * The portal's own download route, e.g. `/app/customer/download`.
   *
   * Explicit rather than defaulted on purpose. Each portal has its own route
   * with its own role check, so a link pointing at another portal's would be
   * refused — and a default would make that the quiet failure mode for
   * whichever portal was added next.
   */
  basePath: string
}

/**
 * A link to a stored file.
 *
 * Points at the portal's own download route rather than at the API: the
 * signed-URL call needs the session cookie, and that has to happen on the
 * server. See any of the route handlers for why.
 *
 * A plain Server Component — no client JS. `prefetch` is irrelevant here
 * because this is an `<a>`, not a `next/link`: prefetching a download route
 * would burn a signed URL on hover.
 */
export function DownloadLink({ fileId, name, basePath }: DownloadLinkProps) {
  return (
    <a
      href={`${basePath}/${fileId}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        color: 'var(--text-brand)',
        fontSize: 'var(--type-body-sm-size)',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
        wordBreak: 'break-all',
      }}
    >
      <Icon name="download" size={16} style={{ flex: 'none' }} />
      {name}
    </a>
  )
}

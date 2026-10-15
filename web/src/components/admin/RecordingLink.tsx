import { Icon } from '@/components/ds/core/Icon'
import { linkHost, safeHttpUrl } from '@/lib/safe-url'

/**
 * The recording link a tester pasted when filing a bug (Drive, Loom, anything
 * hosted elsewhere), shown beside the uploaded files on the bug's evidence tab.
 *
 * It was stored and shown only to the tester who filed it, so an admin or the
 * customer opened a bug whose only evidence was a link and saw "nothing was
 * attached". One component for every portal so none of them forgets it again.
 *
 * Only a web address is ever rendered as a link (see `safeHttpUrl`); anything
 * else is named but left inert, so a value stored before the API checked it
 * cannot run when clicked.
 */
export function RecordingLink({ url }: { url: string | null | undefined }) {
  if (!url?.trim()) return null
  const href = safeHttpUrl(url)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-4)',
        padding: 'var(--space-4) var(--space-5)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <Icon
        name="video"
        size={20}
        style={{ color: 'var(--text-muted)', marginTop: 'var(--space-1)', flex: 'none' }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              color: 'var(--text-brand)',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
              wordBreak: 'break-all',
            }}
          >
            Recording link
          </a>
        ) : (
          <span style={{ color: 'var(--text-secondary)' }}>Recording link</span>
        )}
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: 'var(--type-body-sm-size)',
            wordBreak: 'break-all',
          }}
        >
          {href
            ? `Hosted on ${linkHost(href)} — opens in a new tab`
            : 'This is not a web address, so it is not shown as a link.'}
        </span>
      </div>
    </div>
  )
}

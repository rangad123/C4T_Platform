'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ds/core/Button'
import { Spinner } from '@/components/ds/core/Spinner'
import { Icon } from '@/components/ds/core/Icon'

export interface SingleFileUploadProps {
  /**
   * The Route Handler that stores the bytes — `/app/tester/upload` or
   * `/app/admin/upload`. Each one owns its own allow-list of scopes and MIME
   * types; this component only carries the choice across.
   */
  endpoint: string
  /** Which upload the route should presign. Validated by the route, not here. */
  scope: string
  /** `accept` for the file input. */
  accept: string
  /** Button label at rest. */
  label: string
  /**
   * Called with the finished file id. This is a Server Action bound by the
   * caller — the upload happens over `fetch`, and only the resulting id goes
   * through the action, because a Server Action body is far too small for a
   * file.
   */
  onUploaded: (formData: FormData) => Promise<void>
  /** Shown under the control — the current file's name, when there is one. */
  currentName?: string | null
}

/**
 * Upload one file, then hand its id to a Server Action.
 *
 * Two steps, deliberately: the upload endpoint stores the bytes and returns
 * an id, then that id is submitted through the caller's action to be attached
 * to a record. Splitting them keeps the byte transfer off the
 * Server Action path and means a failed attach never orphans a half-written
 * file — the file is already complete and simply unreferenced.
 *
 * A small `'use client'` leaf. The page around it stays a Server Component.
 */
export function SingleFileUpload({
  endpoint,
  scope,
  accept,
  label,
  onUploaded,
  currentName,
}: SingleFileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function handlePick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset immediately so picking the same file twice still fires a change.
    event.target.value = ''
    if (!file) return

    setError(null)
    setBusy(true)
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('scope', scope)

      const response = await fetch(endpoint, { method: 'POST', body })
      const payload = (await response.json()) as { fileId?: string; error?: string }

      if (!response.ok || !payload.fileId) {
        setError(payload.error ?? 'That upload did not work. Try again.')
        return
      }

      const attach = new FormData()
      attach.append('fileId', payload.fileId)
      startTransition(async () => {
        try {
          await onUploaded(attach)
          // The action revalidates server-side, but this component is what
          // knows the write has landed — refreshing here is what guarantees
          // the panel around it re-renders with the new file rather than
          // sitting on the copy React already has.
          router.refresh()
        } catch {
          setError('The file uploaded but could not be saved. Try again.')
        }
      })
    } catch {
      setError('That upload did not work. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const working = busy || pending

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handlePick}
        className="c4t-visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={working}
          onClick={() => inputRef.current?.click()}
        >
          {working ? (
            <>
              <Spinner size={16} />
              Uploading…
            </>
          ) : (
            <>
              <Icon name="upload" size={16} />
              {label}
            </>
          )}
        </Button>
        {currentName ? (
          <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
            {currentName}
          </span>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          style={{ margin: 0, color: 'var(--status-error-fg)', fontSize: 'var(--type-body-sm-size)' }}
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

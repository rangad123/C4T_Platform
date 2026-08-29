'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { Spinner } from '@/components/ds/core/Spinner'
import { Icon } from '@/components/ds/core/Icon'

export interface InlineFileUploadProps {
  /** Hidden-input name the resulting file id is posted under. */
  name: string
  /** Endpoint that stores the bytes, e.g. `/app/customer/upload`. */
  endpoint: string
  /** Which upload the endpoint should presign. Validated there, not here. */
  scope: string
  /** `accept` for the file input. */
  accept: string
  /** Button label at rest. */
  label: string
  /** A file id already chosen — e.g. carried back in when a step is revisited. */
  defaultFileId?: string
  /** Name to show for that already-chosen file. */
  defaultFileName?: string
  /** Show a small preview of the uploaded image. */
  preview?: boolean
}

/**
 * Uploads a file immediately and keeps its id in the enclosing form.
 *
 * ── HOW THIS DIFFERS FROM `SingleFileUpload`
 *
 * That one attaches the file to a record straight away through a Server
 * Action, which is right when the record already exists. Here the record does
 * not exist yet — this is a wizard collecting fields before anything is
 * created — so the upload happens now (bytes cannot be carried through a
 * multi-step form) and the resulting id waits in a hidden input until the
 * final submit.
 *
 * The file is therefore stored before the project is. That is deliberate: an
 * abandoned wizard leaves an unreferenced `FileObject`, which is harmless and
 * collectable, whereas holding the bytes in the browser across three steps
 * would lose them on any refresh.
 */
export function InlineFileUpload({
  name,
  endpoint,
  scope,
  accept,
  label,
  defaultFileId = '',
  defaultFileName = '',
  preview = false,
}: InlineFileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileId, setFileId] = useState(defaultFileId)
  const [fileName, setFileName] = useState(defaultFileName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset immediately so re-picking the same file still fires a change.
    event.target.value = ''
    if (!file) return

    setError(null)
    setBusy(true)
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('scope', scope)

      const response = await fetch(endpoint, { method: 'POST', body })
      const payload = (await response.json()) as { fileId?: string; name?: string; error?: string }

      if (!response.ok || !payload.fileId) {
        setError(payload.error ?? 'That upload did not work. Try again.')
        return
      }
      setFileId(payload.fileId)
      setFileName(payload.name ?? file.name)
    } catch {
      setError('That upload did not work. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {/* What the enclosing form actually posts. */}
      <input type="hidden" name={name} value={fileId} />

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handlePick}
        className="c4t-visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        {preview && fileId ? (
          // eslint-disable-next-line @next/next/no-img-element -- private file, see /app/files route
          <img
            src={`/app/files/${fileId}`}
            alt=""
            width={48}
            height={48}
            style={{
              width: 48,
              height: 48,
              objectFit: 'contain',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-default)',
              background: 'var(--surface-canvas)',
            }}
          />
        ) : null}

        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <>
              <Spinner size={16} />
              Uploading…
            </>
          ) : (
            <>
              <Icon name="upload" size={16} />
              {fileId ? `Replace ${label.toLowerCase()}` : label}
            </>
          )}
        </Button>

        {fileName ? (
          <span
            style={{
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
              wordBreak: 'break-all',
            }}
          >
            {fileName}
          </span>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            color: 'var(--status-error-fg)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

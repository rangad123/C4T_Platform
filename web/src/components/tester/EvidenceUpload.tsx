'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'

interface Attached {
  fileId: string
  name: string
}

/**
 * Attaches screenshots or recordings to a bug report.
 *
 * Uploads happen as soon as a file is picked, not on form submit — the file
 * has to exist and be marked complete before `POST /bugs` will accept its id,
 * so deferring would mean doing the upload inside the submit and leaving the
 * user staring at a stalled button.
 *
 * Each finished upload contributes a hidden `attachmentFileIds` input, so the
 * surrounding plain `<form>` carries them with no extra wiring; the Server
 * Action reads them with `formData.getAll`.
 *
 * Removing a chip drops the id from the submission but does not delete the
 * stored object — the API exposes no delete for an unattached file, and an
 * orphaned row is harmless. Saying so here so the absence looks deliberate
 * rather than forgotten.
 */
export function EvidenceUpload({ max = 10 }: { max?: number }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [attached, setAttached] = useState<Attached[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    setBusy(true)
    const added: Attached[] = []
    try {
      for (const file of Array.from(files)) {
        if (attached.length + added.length >= max) {
          setError(`You can attach up to ${max} files.`)
          break
        }
        const body = new FormData()
        body.append('file', file)
        const res = await fetch('/app/tester/bugs/upload', { method: 'POST', body })
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null
          setError(payload?.error ?? `Could not upload ${file.name}.`)
          break
        }
        added.push((await res.json()) as Attached)
      }
      if (added.length > 0) setAttached((current) => [...current, ...added])
    } catch {
      setError('The upload failed. Check your connection and try again.')
    } finally {
      setBusy(false)
      // Clear the picker so re-choosing the same file fires `change` again.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {attached.map((item) => (
        <div
          key={item.fileId}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-input)',
            background: 'var(--surface-canvas)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}
          >
            <Icon name="file-text" size={16} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name}
            </span>
          </span>
          <input type="hidden" name="attachmentFileIds" value={item.fileId} />
          <button
            type="button"
            onClick={() => setAttached((c) => c.filter((f) => f.fileId !== item.fileId))}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--status-error-fg)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--type-body-sm-size)',
              padding: 'var(--space-1) var(--space-2)',
            }}
          >
            Remove
          </button>
        </div>
      ))}

      {error ? (
        <p role="alert" style={{ margin: 0, color: 'var(--status-error-fg)', fontSize: 'var(--type-body-sm-size)' }}>
          {error}
        </p>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,video/*,.pdf,.txt,.log"
        onChange={(e) => void handleFiles(e.target.files)}
        style={{ display: 'none' }}
      />
      <div>
        <Button
          type="button"
          variant="secondary"
          iconLeft="image"
          disabled={busy || attached.length >= max}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Uploading…' : 'Attach a screenshot or recording'}
        </Button>
      </div>
    </div>
  )
}

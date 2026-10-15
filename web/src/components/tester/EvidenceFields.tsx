import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { EvidenceUpload } from '@/components/tester/EvidenceUpload'

/** The most files one report may carry, uploaded now and later together. */
export const MAX_EVIDENCE_FILES = 10

/**
 * The evidence part of a bug form: one recording link, and files.
 *
 * One component for filing a report, editing it and adding to it afterwards,
 * so the three cannot offer different things. (The edit form used to take the
 * link but not files, which left a tester with no way to add a screenshot they
 * had forgotten.)
 *
 * The link field's id is `videoUrl` for a new report — the submit guard
 * scrolls to that id — and `<prefix>VideoUrl` elsewhere, so two forms on one
 * page never share an id.
 *
 * `existingFiles` counts what the report already holds, so the picker only
 * offers the room that is left.
 */
export function EvidenceFields({
  idPrefix = '',
  showLink = true,
  defaultVideoUrl = '',
  existingFiles = 0,
}: {
  idPrefix?: string
  /** False when the report can no longer be edited: its link is part of the record, files can still be added. */
  showLink?: boolean
  defaultVideoUrl?: string
  existingFiles?: number
}) {
  const id = idPrefix ? `${idPrefix}VideoUrl` : 'videoUrl'
  const room = Math.max(0, MAX_EVIDENCE_FILES - existingFiles)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      {showLink ? (
        <Field
          label="Video link"
          htmlFor={id}
          hint="A publicly reachable recording — Loom, Drive, anything the team can open without an account."
        >
          <Input
            id={id}
            name="videoUrl"
            type="url"
            maxLength={2000}
            placeholder="https://…"
            defaultValue={defaultVideoUrl}
          />
        </Field>
      ) : null}
      <EvidenceUpload max={room} />
    </div>
  )
}

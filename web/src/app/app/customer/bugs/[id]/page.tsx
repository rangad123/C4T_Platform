import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList, type DescriptionItem } from '@/components/admin/DescriptionList'
import { StatusBadge, SeverityBadge, RoleBadge } from '@/components/admin/StatusBadge'
import { Modal } from '@/components/admin/Modal'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requireRole } from '@/lib/auth/session'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { titleCase, formatDate, personName } from '@/lib/admin/format'
import { addBugComment, moveBugStatus } from './actions'

/**
 * `/app/customer/bugs/[id]` — the bug detail screen, customer side.
 *
 * Subset of `admin/bugs/[id]/page.tsx`: drops Triage (severity) and
 * Classification (type/feature) — both gated on `capabilities.canChangeSeverity`,
 * which policy.ts never grants a customer — and the danger zone
 * (`capabilities.canDelete`, gated on `bug:reporter`, never a customer either).
 * Status moves and comments reuse the exact same `capabilities.*` flags and
 * `availableTransitions` the admin page does — both are already generic
 * per-caller server-side, so no new logic is needed here.
 */

const ROOT = { label: 'Customer', href: '/app/customer' }
const LIST_PATH = '/app/customer/bugs'

const REASON_COPY: Record<string, string> = {
  'no-change': 'Nothing changed. Pick a different value before saving.',
  'note-required': 'Rejecting a bug, or marking it won’t fix, needs a note explaining the decision.',
  'duplicate-required': 'Marking a bug as a duplicate needs the id of the bug it duplicates.',
  empty: 'Write the comment before posting it.',
  conflict: 'That move is not legal from the current status. Reload the page and pick again.',
  forbidden: 'That change is not available on this bug.',
  missing: 'The API could not find that record. Reload the page.',
  invalid: 'The API rejected those values. Check them and try again.',
  failed: 'The bugs service did not accept the change. Try again in a moment.',
}

interface BugPerson {
  id: string
  firstName: string | null
  lastName: string | null
  email?: string | null
}

/** Matches the API's CHECKBOX separator — see `BugCustomValue` in the schema. */
const CUSTOM_ANSWER_SEPARATOR = String.fromCharCode(10)

interface BugDetail {
  /** The client's extra questions for this build, as answered (§39). */
  customValues?: readonly {
    value: string
    field: { id: string; name: string; type: string; position: number }
  }[]
  id: string
  reference: string
  title: string
  description: string
  stepsToReproduce: string
  expectedResult: string | null
  actualResult: string | null
  severity: string
  status: string
  reproducibility: string
  type: string | null
  feature: { id: string; name: string } | null
  deviceModel: string | null
  osName: string | null
  osVersion: string | null
  browser: string | null
  appVersion: string | null
  networkType: string | null
  duplicateOfId: string | null
  triagedAt: string | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  project: { id: string; reference: string; title: string; organisationId: string }
  reportedBy: BugPerson
  attachments: readonly {
    id: string
    caption: string | null
    createdAt: string
    file: { id: string; originalName: string; mimeType: string; sizeBytes: number; downloadUrl: string }
  }[]
  comments: readonly {
    id: string
    body: string
    isInternal: boolean
    createdAt: string
    author: (BugPerson & { role: string }) | null
  }[]
  statusHistory: readonly {
    id: string
    fromStatus: string | null
    toStatus: string
    note: string | null
    createdAt: string
    changedBy: BugPerson | null
  }[]
  duplicateOf: { id: string; reference: string; title: string; status: string } | null
  capabilities: {
    canComment: boolean
    canCommentInternally: boolean
    canAttach: boolean
    availableTransitions: readonly string[]
  }
}

const LINK_STYLE = { color: 'var(--text-brand)', textDecoration: 'underline', textUnderlineOffset: 3 } as const

function panelError(raw: string | undefined, panel: string): string | undefined {
  if (!raw) return undefined
  const separator = raw.indexOf(':')
  if (separator < 1) return undefined
  if (raw.slice(0, separator) !== panel) return undefined
  return REASON_COPY[raw.slice(separator + 1)]
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return '—'
  return value.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

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

function Reported({ text }: { text: string }) {
  return <span style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{text}</span>
}

function FormError({ message }: { message: string | undefined }) {
  if (!message) return null
  return (
    <p role="alert" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start', margin: 0, padding: 'var(--space-4)', borderRadius: 'var(--radius-sm)', background: 'var(--status-error-bg)', color: 'var(--status-error-fg)', fontSize: 'var(--type-body-sm-size)' }}>
      <Icon name="alert-triangle" size={16} />
      {message}
    </p>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>{children}</p>
}

const FORM_STYLE = { display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' } as const

const SECTIONS = [
  { value: 'report', label: 'Report', icon: 'file-text' },
  { value: 'attachments', label: 'Attachments', icon: 'paperclip' },
  { value: 'comments', label: 'Comments', icon: 'message-square' },
  { value: 'history', label: 'History', icon: 'clock' },
] as const

export default async function CustomerBugDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; section?: string; edit?: string }>
}) {
  await requireRole(['CUSTOMER'])

  const { id } = await params
  const { error, section: rawSection, edit } = await searchParams
  const section = resolveSection(SECTIONS, rawSection)

  let bug: BugDetail
  try {
    bug = await serverFetch<BugDetail>(`bugs/${id}`)
  } catch (caught) {
    const status = caught instanceof ApiError ? caught.status : undefined
    if (status === 404) notFound()

    return (
      <DetailShell root={ROOT} crumbs={[{ label: 'Bugs', href: LIST_PATH }, { label: status === 403 ? 'Restricted' : 'Error' }]} eyebrow="Delivery" title={status === 403 ? 'Restricted' : 'Bug unavailable'}>
        {status === 403 ? (
          <EmptyState icon="lock" title="You don't have access to this bug" description="This bug doesn't belong to your organisation." action={<Button href={LIST_PATH} variant="secondary" iconLeft="arrow-left">Back to bugs</Button>} />
        ) : (
          <EmptyState icon="alert-triangle" title="Couldn't load this bug" description="The bugs service is unreachable. Refresh in a moment." action={<Button href={LIST_PATH} variant="secondary" iconLeft="arrow-left">Back to bugs</Button>} />
        )}
      </DetailShell>
    )
  }

  const { capabilities } = bug
  const projectHref = `/app/customer/projects/${bug.project.id}`
  const transitions = capabilities.availableTransitions
  const isDuplicate = bug.status === 'DUPLICATE' || bug.duplicateOfId !== null

  const detailPath = `${LIST_PATH}/${bug.id}`
  const closedHref = section === SECTIONS[0].value ? detailPath : `${detailPath}?section=${section}`
  const statusModalOpen = edit === 'status' || Boolean(error?.startsWith('status:'))

  const reportItems: DescriptionItem[] = [
    { label: 'Reference', value: <span style={{ fontFamily: 'var(--font-mono)' }}>{bug.reference}</span> },
    { label: 'Severity', value: <SeverityBadge severity={bug.severity} /> },
    { label: 'Type', value: bug.type ? titleCase(bug.type) : null },
    { label: 'Feature', value: bug.feature?.name ?? null },
    { label: 'Reproducibility', value: titleCase(bug.reproducibility) },
    { label: 'Description', value: <Reported text={bug.description} />, wide: true },
    { label: 'Steps to reproduce', value: <Reported text={bug.stepsToReproduce} />, wide: true },
    { label: 'Expected result', value: bug.expectedResult ? <Reported text={bug.expectedResult} /> : null, wide: true },
    { label: 'Actual result', value: bug.actualResult ? <Reported text={bug.actualResult} /> : null, wide: true },
  ]

  const environmentItems: DescriptionItem[] = [
    { label: 'Device', value: bug.deviceModel },
    { label: 'OS', value: bug.osName },
    { label: 'OS version', value: bug.osVersion },
    { label: 'Browser', value: bug.browser },
    { label: 'App version', value: bug.appVersion },
    { label: 'Network', value: bug.networkType },
  ]

  const metadataItems: DescriptionItem[] = [
    { label: 'Project', value: <Link href={projectHref} style={LINK_STYLE}>{bug.project.title}</Link> },
    { label: 'Project reference', value: <span style={{ fontFamily: 'var(--font-mono)' }}>{bug.project.reference}</span> },
    { label: 'Reported', value: formatDate(bug.createdAt) },
    { label: 'Triaged', value: formatDate(bug.triagedAt) },
    { label: 'Resolved', value: formatDate(bug.resolvedAt) },
    { label: 'Last updated', value: formatDate(bug.updatedAt) },
  ]

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Bugs', href: LIST_PATH }, { label: bug.reference }]}
      eyebrow="Delivery"
      title={bug.title}
      badges={<><SeverityBadge severity={bug.severity} /><StatusBadge status={bug.status} /></>}
      subtitle={<>{bug.reference} · reported {formatTimestamp(bug.createdAt)} on <Link href={projectHref} style={LINK_STYLE}>{bug.project.title}</Link></>}
      tabs={
        <SectionTabs
          basePath={detailPath}
          tabs={SECTIONS.map((t) =>
            t.value === 'attachments' ? { ...t, count: bug.attachments.length } : t.value === 'comments' ? { ...t, count: bug.comments.length } : t,
          )}
          active={section}
        />
      }
      aside={
        <>
          <Panel title="Status" description="Only the moves the API will accept from this status are listed." actions={transitions.length > 0 ? <Button href={`${detailPath}?section=${section}&edit=status`} variant="secondary" size="sm">Edit</Button> : undefined}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {isDuplicate ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-4)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-sunken)' }}>
                  <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>Duplicate of</span>
                  {bug.duplicateOf ? (
                    <Link href={`${LIST_PATH}/${bug.duplicateOf.id}`} style={{ ...LINK_STYLE, fontSize: 'var(--type-body-sm-size)' }}>
                      {bug.duplicateOf.reference} — {bug.duplicateOf.title}
                    </Link>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
                      Marked a duplicate, but the bug it pointed at has since been removed.
                    </span>
                  )}
                </div>
              ) : null}
              {transitions.length === 0 ? (
                <Note>There is no move available from {titleCase(bug.status).toLowerCase()} for your role.</Note>
              ) : (
                <StatusBadge status={bug.status} />
              )}
            </div>
          </Panel>

          {transitions.length > 0 ? (
            <Modal open={statusModalOpen} closedHref={closedHref} title="Move status">
              <TrackedForm action={moveBugStatus} style={FORM_STYLE}>
                <input type="hidden" name="id" value={bug.id} />
                <FormError message={panelError(error, 'status')} />
                <Field label="Move to" htmlFor="status" required>
                  <Select id="status" name="status" required placeholder="Choose a move" options={transitions.map((value) => ({ value, label: titleCase(value) }))} />
                </Field>
                {transitions.includes('DUPLICATE') ? (
                  <Field label="Duplicate of" htmlFor="duplicateOfId" hint="Required when marking a duplicate. Paste the id of the earlier bug — it must be on this project.">
                    <Input id="duplicateOfId" name="duplicateOfId" defaultValue={bug.duplicateOfId ?? ''} placeholder="Bug id" autoComplete="off" spellCheck={false} />
                  </Field>
                ) : null}
                {isDuplicate && !transitions.includes('DUPLICATE') ? (
                  <Checkbox name="clearDuplicate" label="Clear the duplicate link" description="A duplicate reference only means something while the status is duplicate." />
                ) : null}
                <Field label="Note" htmlFor="note" hint="Recorded against the move. Required when rejecting a bug or marking it won’t fix.">
                  <Textarea id="note" name="note" rows={4} placeholder="What did you find, and what happens next?" />
                </Field>
                <SubmitButton variant="primary" fullWidth pendingLabel="Saving status…">Save status</SubmitButton>
              </TrackedForm>
            </Modal>
          ) : null}

          <Panel title="Details">
            <DescriptionList items={metadataItems} />
          </Panel>
        </>
      }
    >
      {section === 'report' ? (
        <Panel title="Report" description="The defect exactly as the tester filed it.">
          <DescriptionList items={reportItems} />
          <div style={{ marginTop: 'var(--space-6)', paddingTop: 'var(--space-6)', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <h3 className="c4t-heading-sm" style={{ margin: 0 }}>Captured environment</h3>
            <DescriptionList items={environmentItems} />
          </div>
          {/* The client's own extra questions, as the tester answered them.
              Rendered only when there are answers: a build with no extra
              fields should not grow an empty heading. */}
          {bug.customValues && bug.customValues.length > 0 ? (
            <div
              style={{
                marginTop: 'var(--space-6)',
                paddingTop: 'var(--space-6)',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
              }}
            >
              <h3 className="c4t-heading-sm" style={{ margin: 0 }}>
                Extra details for this build
              </h3>
              <DescriptionList
                items={bug.customValues.map((entry) => ({
                  label: entry.field.name,
                  /* A multiple-choice answer is stored newline-joined, so it
                     is split back out rather than shown as one run-on line. */
                  value: entry.value.includes(CUSTOM_ANSWER_SEPARATOR)
                    ? entry.value.split(CUSTOM_ANSWER_SEPARATOR).join(', ')
                    : entry.value,
                  wide: entry.field.type === 'TEXTAREA',
                }))}
              />
            </div>
          ) : null}

        </Panel>
      ) : null}

      {section === 'attachments' ? (
        <Panel title="Attachments" description="Screenshots and recordings filed with the report. Download links are signed and short-lived.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            {bug.attachments.length === 0 ? (
              <Note>Nothing was attached to this report.</Note>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {bug.attachments.map((attachment) => (
                  <li key={attachment.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-5)', padding: 'var(--space-4) var(--space-5)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-card)' }}>
                    <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-start', minWidth: 0 }}>
                      <Icon name={attachment.file.mimeType.startsWith('image/') ? 'image' : 'file-text'} size={20} style={{ color: 'var(--text-muted)', marginTop: 'var(--space-1)' }} />
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <a href={attachment.file.downloadUrl} target="_blank" rel="noreferrer" style={{ ...LINK_STYLE, wordBreak: 'break-word' }}>{attachment.file.originalName}</a>
                        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
                          {formatBytes(attachment.file.sizeBytes)} · {attachment.file.mimeType} · added {formatDate(attachment.createdAt)}
                        </span>
                        {attachment.caption ? <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>{attachment.caption}</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      ) : null}

      {section === 'comments' ? (
        <Panel title="Comments" description="The conversation on this defect.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {bug.comments.length === 0 ? (
              <Note>No comments yet.</Note>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {bug.comments.map((comment) => (
                  <li key={comment.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-5)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-card)', background: 'var(--surface-canvas)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 'var(--fw-semibold)' }}>{personName(comment.author)}</span>
                      <RoleBadge role={comment.author?.role} />
                      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>{formatTimestamp(comment.createdAt)}</span>
                    </div>
                    <Reported text={comment.body} />
                  </li>
                ))}
              </ul>
            )}

            <form action={addBugComment} style={{ ...FORM_STYLE, paddingTop: 'var(--space-5)', borderTop: '1px solid var(--border-subtle)' }}>
              <input type="hidden" name="id" value={bug.id} />
              <FormError message={panelError(error, 'comment')} />
              <Field label="Add a comment" htmlFor="body" required>
                <Textarea id="body" name="body" rows={4} required maxLength={5000} placeholder="Ask a question, or add context for the tester." />
              </Field>
              <div>
                <SubmitButton variant="primary" disabled={!capabilities.canComment} pendingLabel="Posting…">Post comment</SubmitButton>
              </div>
            </form>
          </div>
        </Panel>
      ) : null}

      {section === 'history' ? (
        <Panel title="Status history" description="Every lifecycle move on this report, oldest first.">
          {bug.statusHistory.length === 0 ? (
            <Note>Nothing recorded yet.</Note>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {bug.statusHistory.map((entry) => (
                <li key={entry.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    {entry.fromStatus ? (
                      <>
                        <StatusBadge status={entry.fromStatus} />
                        <Icon name="arrow-right" size={16} style={{ color: 'var(--text-muted)' }} />
                      </>
                    ) : null}
                    <StatusBadge status={entry.toStatus} />
                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
                      {personName(entry.changedBy)} · {formatTimestamp(entry.createdAt)}
                    </span>
                  </div>
                  {entry.note ? <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)', whiteSpace: 'pre-wrap' }}>{entry.note}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </Panel>
      ) : null}
    </DetailShell>
  )
}

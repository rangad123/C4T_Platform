import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList, type DescriptionItem } from '@/components/admin/DescriptionList'
import { StatusBadge, SeverityBadge, RoleBadge } from '@/components/admin/StatusBadge'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requireRole } from '@/lib/auth/session'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { titleCase, formatDate, personName } from '@/lib/admin/format'
import {
  triageBugSeverity,
  updateBugClassification,
  moveBugStatus,
  addBugComment,
  removeBugAttachment,
  deleteBug,
} from './actions'

/**
 * `/app/admin/bugs/[id]` — the bug detail and triage screen.
 *
 * This is where §2.2 project management meets §2.3 tester bug tracking: the
 * left column is the report exactly as the tester filed it, and the aside is
 * everything an admin does to it.
 *
 * The transition matrix is NOT reimplemented here. `GET /bugs/:id` returns
 * `capabilities.availableTransitions` precisely so that each frontend does not
 * grow its own copy of the rules and drift from the API — offering "Verify" on
 * a bug the service will refuse is exactly the failure that field prevents. The
 * status select is built from it verbatim.
 */

const LIST_PATH = '/app/admin/bugs'

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const BUG_TYPES = ['CRASH', 'APP_FREEZE', 'FUNCTIONAL', 'UI', 'UX', 'SECURITY', 'PERFORMANCE'] as const

/** Fixed copy for every reason code `./actions.ts` can redirect with. */
const REASON_COPY: Record<string, string> = {
  'no-change': 'Nothing changed. Pick a different value before saving.',
  'note-required':
    'Rejecting a bug, or marking it won’t fix, needs a note explaining the decision.',
  'duplicate-required': 'Marking a bug as a duplicate needs the id of the bug it duplicates.',
  empty: 'Write the comment before posting it.',
  mismatch: 'That reference did not match, so the report was left alone.',
  conflict: 'That move is not legal from the current status. Reload the page and pick again.',
  forbidden: 'You do not hold the permission that change needs. Ask an administrator.',
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

interface BugDetail {
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
  featureId: string | null
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
  _count: { attachments: number; comments: number }
  attachments: readonly {
    id: string
    caption: string | null
    createdAt: string
    file: {
      id: string
      originalName: string
      mimeType: string
      sizeBytes: number
      downloadUrl: string
    }
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
    canEdit: boolean
    canDelete: boolean
    canComment: boolean
    canCommentInternally: boolean
    canAttach: boolean
    canChangeSeverity: boolean
    availableTransitions: readonly string[]
  }
}

const LINK_STYLE = {
  color: 'var(--text-brand)',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
} as const

/**
 * Reads `?error=<panel>:<reason>`, and only returns copy this file owns.
 *
 * Nothing from the query string reaches the page — an unrecognised panel or
 * reason renders nothing at all, so a hand-crafted URL cannot put words in the
 * admin panel's mouth.
 */
function panelError(raw: string | undefined, panel: string): string | undefined {
  if (!raw) return undefined
  const separator = raw.indexOf(':')
  if (separator < 1) return undefined
  if (raw.slice(0, separator) !== panel) return undefined
  return REASON_COPY[raw.slice(separator + 1)]
}

/**
 * Date and time, for the streams where ordering within a day is the point.
 *
 * The metadata list uses the shared `formatDate` like every other admin page;
 * comments and the status trail need the clock as well, and a triage argument
 * that ran over one afternoon is unreadable without it.
 */
function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return '—'
  return value.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
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

/**
 * Reported text, with its line breaks intact.
 *
 * Load-bearing for `stepsToReproduce`: the field is numbered lines typed by the
 * tester, and collapsing the whitespace turns a reproducible recipe into one
 * unreadable paragraph. The same treatment applies to every free-text field for
 * consistency — a tester who paragraphs their description meant to.
 */
function Reported({ text }: { text: string }) {
  return <span style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{text}</span>
}

/** An inline warning inside the panel whose form produced it. */
function FormError({ message }: { message: string | undefined }) {
  if (!message) return null
  return (
    <p
      role="alert"
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'flex-start',
        margin: 0,
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--status-error-bg)',
        color: 'var(--status-error-fg)',
        fontSize: 'var(--type-body-sm-size)',
      }}
    >
      <Icon name="alert-triangle" size={16} />
      {message}
    </p>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        color: 'var(--text-secondary)',
        fontSize: 'var(--type-body-sm-size)',
      }}
    >
      {children}
    </p>
  )
}

const FORM_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-5)',
} as const

/**
 * Four things live on a bug, and they are read at different moments: the
 * report itself (triage), what was attached (reproduction), the discussion
 * (working it), and the status trail (audit). Stacked they were one long
 * scroll where a busy comment thread pushed the trail off the bottom.
 *
 * The aside — triage, classification, status — stays outside the sections:
 * it is what you act on, and it has to stay reachable from every tab.
 */
const SECTIONS = [
  { value: 'report', label: 'Report', icon: 'file-text' },
  { value: 'attachments', label: 'Attachments', icon: 'paperclip' },
  { value: 'comments', label: 'Comments', icon: 'message-square' },
  { value: 'history', label: 'History', icon: 'clock' },
] as const

export default async function BugDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; section?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const { id } = await params
  const { error, section: rawSection } = await searchParams
  const section = resolveSection(SECTIONS, rawSection)

  let bug: BugDetail
  try {
    // `serverFetch` unwraps the `{ data }` envelope — this IS the bug.
    bug = await serverFetch<BugDetail>(`bugs/${id}`)
  } catch (caught) {
    const status = caught instanceof ApiError ? caught.status : undefined

    // The API answers an unreadable bug with 404 rather than 403 on purpose: a
    // 403 would confirm the record exists to someone who may not know that.
    if (status === 404) notFound()

    return (
      <DetailShell
        crumbs={[{ label: 'Bugs', href: LIST_PATH }, { label: status === 403 ? 'Restricted' : 'Error' }]}
        eyebrow="Delivery"
        title={status === 403 ? 'Restricted' : 'Bug unavailable'}
      >
        {status === 403 ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this bug"
            description="Ask an administrator to grant you the bug.read permission."
            action={
              <Button href={LIST_PATH} variant="secondary" iconLeft="arrow-left">
                Back to bugs
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load this bug"
            description="The bugs service is unreachable. Refresh in a moment."
            action={
              <Button href={LIST_PATH} variant="secondary" iconLeft="arrow-left">
                Back to bugs
              </Button>
            }
          />
        )}
      </DetailShell>
    )
  }

  const { capabilities } = bug
  const projectHref = `/app/admin/projects/${bug.project.id}`
  const transitions = capabilities.availableTransitions
  const canMarkDuplicate = transitions.includes('DUPLICATE')

  // Best-effort: a reader without project.read on this project (rare — bug
  // access and project access are usually granted together) just gets no
  // feature options rather than a broken page.
  const features = await serverFetchOrNull<readonly { id: string; name: string }[]>(
    `projects/${bug.project.id}/features`,
  )
  const isDuplicate = bug.status === 'DUPLICATE' || bug.duplicateOfId !== null

  const reportItems: DescriptionItem[] = [
    {
      label: 'Reference',
      value: <span style={{ fontFamily: 'var(--font-mono)' }}>{bug.reference}</span>,
    },
    { label: 'Severity', value: <SeverityBadge severity={bug.severity} /> },
    { label: 'Type', value: bug.type ? titleCase(bug.type) : null },
    { label: 'Feature', value: bug.feature?.name ?? null },
    { label: 'Reproducibility', value: titleCase(bug.reproducibility) },
    { label: 'Description', value: <Reported text={bug.description} />, wide: true },
    {
      label: 'Steps to reproduce',
      value: <Reported text={bug.stepsToReproduce} />,
      wide: true,
    },
    {
      label: 'Expected result',
      value: bug.expectedResult ? <Reported text={bug.expectedResult} /> : null,
      wide: true,
    },
    {
      label: 'Actual result',
      value: bug.actualResult ? <Reported text={bug.actualResult} /> : null,
      wide: true,
    },
  ]

  // Every environment field is listed even when empty: a report that captured
  // nothing about the network is a fact worth seeing, and DescriptionList draws
  // an em dash rather than collapsing the row.
  const environmentItems: DescriptionItem[] = [
    { label: 'Device', value: bug.deviceModel },
    { label: 'OS', value: bug.osName },
    { label: 'OS version', value: bug.osVersion },
    { label: 'Browser', value: bug.browser },
    { label: 'App version', value: bug.appVersion },
    { label: 'Network', value: bug.networkType },
  ]

  const metadataItems: DescriptionItem[] = [
    {
      label: 'Project',
      value: (
        <Link href={projectHref} style={LINK_STYLE}>
          {bug.project.title}
        </Link>
      ),
    },
    {
      label: 'Project reference',
      value: <span style={{ fontFamily: 'var(--font-mono)' }}>{bug.project.reference}</span>,
    },
    { label: 'Reported by', value: personName(bug.reportedBy) },
    { label: 'Reported', value: formatDate(bug.createdAt) },
    { label: 'Triaged', value: formatDate(bug.triagedAt) },
    { label: 'Resolved', value: formatDate(bug.resolvedAt) },
    { label: 'Last updated', value: formatDate(bug.updatedAt) },
  ]

  return (
    <DetailShell
      crumbs={[{ label: 'Bugs', href: LIST_PATH }, { label: bug.reference }]}
      eyebrow="Delivery"
      title={bug.title}
      badges={
        <>
          <SeverityBadge severity={bug.severity} />
          <StatusBadge status={bug.status} />
        </>
      }
      subtitle={
        <>
          {bug.reference} · reported {formatTimestamp(bug.createdAt)} by{' '}
          {personName(bug.reportedBy)} on{' '}
          <Link href={projectHref} style={LINK_STYLE}>
            {bug.project.title}
          </Link>
        </>
      }
      tabs={
        <SectionTabs
          basePath={`${LIST_PATH}/${bug.id}`}
          tabs={SECTIONS.map((t) =>
            t.value === 'attachments'
              ? { ...t, count: bug.attachments.length }
              : t.value === 'comments'
                ? { ...t, count: bug.comments.length }
                : t,
          )}
          active={section}
        />
      }
      aside={
        <>
          {/* ── Triage: severity ─────────────────────────────────────────── */}
          <Panel
            title="Triage"
            description="Severity is the platform's judgement, not the customer's."
          >
            {capabilities.canChangeSeverity ? (
              <form action={triageBugSeverity} style={FORM_STYLE}>
                <input type="hidden" name="id" value={bug.id} />
                <input type="hidden" name="currentSeverity" value={bug.severity} />
                <FormError message={panelError(error, 'triage')} />
                <Field
                  label="Severity"
                  htmlFor="severity"
                  hint="Re-grading a bug does not move it through the lifecycle."
                >
                  <Select
                    id="severity"
                    name="severity"
                    defaultValue={bug.severity}
                    options={SEVERITIES.map((value) => ({ value, label: titleCase(value) }))}
                  />
                </Field>
                <Button type="submit" variant="primary" fullWidth>
                  Save severity
                </Button>
              </form>
            ) : (
              <Note>
                Only an administrator or the project&rsquo;s manager can re-grade severity. Ask for
                the bug.triage permission.
              </Note>
            )}
          </Panel>

          {/* ── Classification: type + feature ───────────────────────────── */}
          <Panel
            title="Classification"
            description="What kind of defect this is, and which part of the product it's in."
          >
            {capabilities.canChangeSeverity ? (
              <TrackedForm action={updateBugClassification} style={FORM_STYLE}>
                <input type="hidden" name="id" value={bug.id} />
                <FormError message={panelError(error, 'triage')} />
                <Field label="Type" htmlFor="type" hint="Leave blank if it doesn't fit a category.">
                  <Select
                    id="type"
                    name="type"
                    defaultValue={bug.type ?? ''}
                    options={[
                      { value: '', label: 'None' },
                      ...BUG_TYPES.map((value) => ({ value, label: titleCase(value) })),
                    ]}
                  />
                </Field>
                <Field label="Feature" htmlFor="featureId">
                  <Select
                    id="featureId"
                    name="featureId"
                    defaultValue={bug.featureId ?? ''}
                    options={[
                      { value: '', label: features && features.length > 0 ? 'None' : 'No features yet' },
                      ...(features ?? []).map((f) => ({ value: f.id, label: f.name })),
                    ]}
                  />
                </Field>
                <Button type="submit" variant="primary" fullWidth>
                  Save classification
                </Button>
              </TrackedForm>
            ) : (
              <Note>
                Only an administrator or the project&rsquo;s manager can reclassify a bug. Ask for
                the bug.triage permission.
              </Note>
            )}
          </Panel>

          {/* ── Status: the lifecycle ────────────────────────────────────── */}
          <Panel
            title="Status"
            description="Only the moves the API will accept from this status are listed."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {isDuplicate ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-4)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-sunken)',
                  }}
                >
                  <span className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
                    Duplicate of
                  </span>
                  {bug.duplicateOf ? (
                    <Link
                      href={`${LIST_PATH}/${bug.duplicateOf.id}`}
                      style={{ ...LINK_STYLE, fontSize: 'var(--type-body-sm-size)' }}
                    >
                      {bug.duplicateOf.reference} — {bug.duplicateOf.title}
                    </Link>
                  ) : (
                    <span
                      style={{
                        color: 'var(--text-secondary)',
                        fontSize: 'var(--type-body-sm-size)',
                      }}
                    >
                      Marked a duplicate, but the bug it pointed at has since been removed.
                    </span>
                  )}
                </div>
              ) : null}

              {transitions.length === 0 ? (
                <Note>
                  There is no move available from {titleCase(bug.status).toLowerCase()} for your
                  role. An administrator can reopen the report if it needs to move again.
                </Note>
              ) : (
                <TrackedForm action={moveBugStatus} style={FORM_STYLE}>
                  <input type="hidden" name="id" value={bug.id} />
                  <FormError message={panelError(error, 'status')} />

                  <Field label="Move to" htmlFor="status" required>
                    <Select
                      id="status"
                      name="status"
                      required
                      placeholder="Choose a move"
                      options={transitions.map((value) => ({
                        value,
                        label: titleCase(value),
                      }))}
                    />
                  </Field>

                  {canMarkDuplicate ? (
                    <Field
                      label="Duplicate of"
                      htmlFor="duplicateOfId"
                      hint="Required when marking a duplicate. Paste the id of the earlier bug — it must be on this project."
                    >
                      <Input
                        id="duplicateOfId"
                        name="duplicateOfId"
                        defaultValue={bug.duplicateOfId ?? ''}
                        placeholder="Bug id"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                  ) : null}

                  {isDuplicate && !canMarkDuplicate ? (
                    <Checkbox
                      name="clearDuplicate"
                      label="Clear the duplicate link"
                      description="A duplicate reference only means something while the status is duplicate."
                    />
                  ) : null}

                  <Field
                    label="Note"
                    htmlFor="note"
                    hint="Recorded against the move and sent to the reporter. Required when rejecting a bug or marking it won’t fix."
                  >
                    <Textarea
                      id="note"
                      name="note"
                      rows={4}
                      placeholder="What did you find, and what happens next?"
                    />
                  </Field>

                  <Button type="submit" variant="primary" fullWidth>
                    Save status
                  </Button>
                </TrackedForm>
              )}
            </div>
          </Panel>

          {/* ── Metadata ─────────────────────────────────────────────────── */}
          <Panel title="Details">
            <DescriptionList items={metadataItems} />
          </Panel>

          {/* ── Danger zone ──────────────────────────────────────────────── */}
          {capabilities.canDelete ? (
            <Panel
              title="Withdraw this report"
              description="The bug drops out of every list and stops counting towards the reporter's accepted total."
            >
              <form action={deleteBug} style={FORM_STYLE}>
                <input type="hidden" name="id" value={bug.id} />
                <input type="hidden" name="reference" value={bug.reference} />
                <FormError message={panelError(error, 'delete')} />
                <Field
                  label={`Type ${bug.reference} to confirm`}
                  htmlFor="confirmation"
                  hint="We keep the record, but nobody will see it again from the app."
                >
                  <Input
                    id="confirmation"
                    name="confirmation"
                    required
                    placeholder={bug.reference}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Button type="submit" variant="secondary" fullWidth>
                  Withdraw report
                </Button>
              </form>
            </Panel>
          ) : null}
        </>
      }
    >
      {section === 'report' ? (
        <>
          {/* ── The report, as filed ───────────────────────────────────────── */}
          <Panel
            title="Report"
            description="The defect exactly as the tester filed it. Only the reporter may correct it, and only before triage."
          >
            <DescriptionList items={reportItems} />

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
                Captured environment
              </h3>
              <DescriptionList items={environmentItems} />
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'attachments' ? (
        <>
          {/* ── Attachments ───────────────────────────────────────────────── */}
          <Panel
            title="Attachments"
            description="Screenshots and recordings filed with the report. Download links are signed and short-lived."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <FormError message={panelError(error, 'attachment')} />

              {bug.attachments.length === 0 ? (
                <Note>
                  Nothing was attached. Testers add screenshots and recordings when they file the
                  report, or from the tester portal afterwards.
                </Note>
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                  }}
                >
                  {bug.attachments.map((attachment) => (
                    <li
                      key={attachment.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 'var(--space-5)',
                        padding: 'var(--space-4) var(--space-5)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-card)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: 'var(--space-4)',
                          alignItems: 'flex-start',
                          minWidth: 0,
                        }}
                      >
                        <Icon
                          name={attachment.file.mimeType.startsWith('image/') ? 'image' : 'file-text'}
                          size={20}
                          style={{ color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <a
                            href={attachment.file.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ ...LINK_STYLE, wordBreak: 'break-word' }}
                          >
                            {attachment.file.originalName}
                          </a>
                          <span
                            style={{
                              color: 'var(--text-muted)',
                              fontSize: 'var(--type-body-sm-size)',
                            }}
                          >
                            {formatBytes(attachment.file.sizeBytes)} · {attachment.file.mimeType} ·
                            added {formatDate(attachment.createdAt)}
                          </span>
                          {attachment.caption ? (
                            <span
                              style={{
                                color: 'var(--text-secondary)',
                                fontSize: 'var(--type-body-sm-size)',
                              }}
                            >
                              {attachment.caption}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {capabilities.canAttach ? (
                        <form action={removeBugAttachment}>
                          <input type="hidden" name="id" value={bug.id} />
                          <input type="hidden" name="attachmentId" value={attachment.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Remove
                          </Button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'comments' ? (
        <>
          {/* ── Comments ──────────────────────────────────────────────────── */}
          <Panel
            title="Comments"
            description="The conversation on this defect. Internal notes are hidden from the customer and the reporter."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {bug.comments.length === 0 ? (
                <Note>No comments yet. Say what you found, or what you need from the reporter.</Note>
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-4)',
                  }}
                >
                  {bug.comments.map((comment) => (
                    <li
                      key={comment.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-3)',
                        padding: 'var(--space-5)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-card)',
                        background: comment.isInternal
                          ? 'var(--surface-sunken)'
                          : 'var(--surface-canvas)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 'var(--space-3)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontWeight: 'var(--fw-semibold)' }}>
                          {personName(comment.author)}
                        </span>
                        <RoleBadge role={comment.author?.role} />
                        {comment.isInternal ? <Badge tone="warning">Internal</Badge> : null}
                        <span
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: 'var(--type-body-sm-size)',
                          }}
                        >
                          {formatTimestamp(comment.createdAt)}
                        </span>
                      </div>
                      <Reported text={comment.body} />
                    </li>
                  ))}
                </ul>
              )}

              <form
                action={addBugComment}
                style={{
                  ...FORM_STYLE,
                  paddingTop: 'var(--space-5)',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <input type="hidden" name="id" value={bug.id} />
                <FormError message={panelError(error, 'comment')} />
                <Field label="Add a comment" htmlFor="body" required>
                  <Textarea
                    id="body"
                    name="body"
                    rows={4}
                    required
                    maxLength={5000}
                    placeholder="Ask the reporter for a build number, or record what triage decided."
                  />
                </Field>
                {capabilities.canCommentInternally ? (
                  <Checkbox
                    name="isInternal"
                    label="Post as an internal note"
                    description="Visible to platform staff and project managers only."
                  />
                ) : null}
                <div>
                  <Button type="submit" variant="primary" disabled={!capabilities.canComment}>
                    Post comment
                  </Button>
                </div>
              </form>
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'history' ? (
        <>
          {/* ── The triage trail ──────────────────────────────────────────── */}
          <Panel
            title="Status history"
            description="Every lifecycle move on this report, oldest first."
          >
            {bug.statusHistory.length === 0 ? (
              <Note>Nothing recorded yet.</Note>
            ) : (
              <ol
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-4)',
                }}
              >
                {bug.statusHistory.map((entry) => (
                  <li
                    key={entry.id}
                    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        flexWrap: 'wrap',
                      }}
                    >
                      {entry.fromStatus ? (
                        <>
                          <StatusBadge status={entry.fromStatus} />
                          <Icon name="arrow-right" size={16} style={{ color: 'var(--text-muted)' }} />
                        </>
                      ) : null}
                      <StatusBadge status={entry.toStatus} />
                      <span
                        style={{
                          color: 'var(--text-muted)',
                          fontSize: 'var(--type-body-sm-size)',
                        }}
                      >
                        {personName(entry.changedBy)} · {formatTimestamp(entry.createdAt)}
                      </span>
                    </div>
                    {entry.note ? (
                      <span
                        style={{
                          color: 'var(--text-secondary)',
                          fontSize: 'var(--type-body-sm-size)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {entry.note}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </>
      ) : null}

    </DetailShell>
  )
}

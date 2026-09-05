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
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requireRole } from '@/lib/auth/session'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { titleCase, formatDate, formatDateTime, personName } from '@/lib/admin/format'
import { addBugComment, moveBugStatus, updateBugAction } from './actions'
import { PairSelect } from '@/components/ds/forms/PairSelect'
import { loadBugEnvironmentOptions } from '@/lib/catalog/target-options'
import { BUG_REPRODUCIBILITIES, BUG_SEVERITIES, BUG_TYPES } from '@/lib/domain/enums'

const ROOT = { label: 'Tester', href: '/app/tester' }
const DETAIL_BASE = '/app/tester/bugs'
const PROJECTS_PATH = '/app/tester/projects'

/**
 * `/app/tester/bugs/[id]` — one defect, as its reporter sees it.
 *
 * The bug list has always linked rows here; until now the route did not
 * exist, so every row click 404'd. This is that page.
 *
 * It is deliberately the same shape as the admin bug page (DetailShell +
 * SectionTabs + a capabilities-driven aside), minus everything a tester does
 * not hold: no severity re-grade, no classification, no internal comments, no
 * withdraw. Those are not hidden buttons — the controls simply are not
 * rendered, because `capabilities` says the API would refuse them.
 *
 * The status control is built from `capabilities.availableTransitions`
 * verbatim rather than from a local copy of the workflow. That field exists
 * precisely so each frontend does not grow its own transition table and drift
 * from the service.
 */

const REASON_COPY: Record<string, string> = {
  empty: 'Write the comment before posting it.',
  'no-change': 'Choose a status before saving.',
  conflict: 'That move is not legal from the current status. Reload the page and try again.',
  forbidden: 'That change is not yours to make on this report.',
  missing: 'That record is no longer there. Reload the page.',
  invalid: 'That was not accepted.',
  failed: 'The bugs service did not accept the change. Try again in a moment.',
  'occurrence-pair':
    'Give both how many times it happened and how many attempts you made, or leave both blank.',
  'occurrence-range': 'It cannot have happened more times than you tried.',
}

const SEVERITIES = BUG_SEVERITIES

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
  preCondition: string | null
  stepsToReproduce: string
  expectedResult: string | null
  actualResult: string | null
  severity: string
  status: string
  reproducibility: string
  occurrence: number | null
  outOf: number | null
  videoUrl: string | null
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
  project: { id: string; reference: string; title: string }
  build?: { id: string; name: string } | null
  reportedBy: BugPerson
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
 * Reads `?error=<panel>:<reason>` and returns only copy this file owns.
 * Nothing from the query string reaches the page, so a hand-built URL cannot
 * put words in the app's mouth.
 */
function panelError(raw: string | undefined, panel: string): string | undefined {
  if (!raw) return undefined
  const separator = raw.indexOf(':')
  if (separator < 1) return undefined
  if (raw.slice(0, separator) !== panel) return undefined
  return REASON_COPY[raw.slice(separator + 1)]
}

/**
 * Human labels for the fields a rejection can name.
 *
 * The action passes a TOKEN, never the API's sentence, so this map is what
 * turns it into words — keeping `panelError`'s rule that nothing from the
 * query string reaches the reader. A token that is not in here renders
 * nothing, so a hand-built URL cannot invent a field.
 */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  preCondition: 'Pre-condition',
  stepsToReproduce: 'Steps to reproduce',
  expectedResult: 'Expected result',
  actualResult: 'Actual result',
  severity: 'Severity',
  reproducibility: 'Reproducibility',
  occurrence: 'Occurrence',
  outOf: 'Out of',
  type: 'Type',
  featureId: 'Feature',
  videoUrl: 'Video URL',
  deviceModel: 'Device model',
  osName: 'OS name',
  osVersion: 'OS version',
  browser: 'Browser',
  appVersion: 'App version',
  networkType: 'Network type',
}

/** This page's own words, from a token it recognises. */
function fieldHint(token: string | undefined): string {
  const label = token ? FIELD_LABELS[token] : undefined
  return label ? ` Check the ${label} field.` : ' Check the values and try again.'
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

/** Reported text keeps its line breaks — numbered repro steps depend on them. */
function Reported({ text }: { text: string }) {
  return <span style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{text}</span>
}

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
    <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
      {children}
    </p>
  )
}

const FORM_STYLE = { display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' } as const

const SECTIONS = [
  { value: 'report', label: 'Report', icon: 'file-text' },
  { value: 'attachments', label: 'Evidence', icon: 'paperclip' },
  { value: 'comments', label: 'Comments', icon: 'message-square' },
  { value: 'history', label: 'History', icon: 'clock' },
] as const

export default async function TesterBugDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; section?: string; edit?: string; field?: string }>
}) {
  await requireRole(['TESTER'])

  const { id } = await params
  const { error, section: rawSection, edit, field } = await searchParams
  const section = resolveSection(SECTIONS, rawSection)

  let bug: BugDetail
  try {
    bug = await serverFetch<BugDetail>(`bugs/${id}`)
  } catch (caught) {
    const status = caught instanceof ApiError ? caught.status : undefined
    if (status === 404) notFound()

    return (
      <DetailShell
        root={ROOT}
        crumbs={[
          { label: 'Projects', href: PROJECTS_PATH },
          { label: status === 403 ? 'Restricted' : 'Error' },
        ]}
        eyebrow="Work"
        title={status === 403 ? 'Restricted' : 'Bug unavailable'}
      >
        <EmptyState
          icon={status === 403 ? 'lock' : 'alert-triangle'}
          title={status === 403 ? "You don't have access to this bug" : "Couldn't load this bug"}
          description={
            status === 403
              ? 'It was filed on a project you are not on.'
              : 'The bugs service is unreachable. Refresh in a moment.'
          }
          action={
            <Button href={PROJECTS_PATH} variant="secondary" iconLeft="arrow-left">
              Back to bugs
            </Button>
          }
        />
      </DetailShell>
    )
  }

  const { capabilities } = bug
  const transitions = capabilities.availableTransitions
  const isDuplicate = bug.status === 'DUPLICATE' || bug.duplicateOfId !== null
  const detailPath = `${DETAIL_BASE}/${bug.id}`
  const closedHref = section === SECTIONS[0].value ? detailPath : `${detailPath}?section=${section}`
  const statusModalOpen = edit === 'status' || Boolean(error?.startsWith('status:'))
  const reportModalOpen = edit === 'edit-report' || Boolean(error?.startsWith('report:'))
  const projectHref = `/app/tester/projects/${bug.project.id}`

  /**
   * Only fetched when the edit form can actually render — `capabilities`
   * already told us `canEdit` is API-enforced (still `NEW`), so a bug past
   * that window never pays for a features lookup it cannot use.
   */
  const features = capabilities.canEdit
    ? await serverFetchOrNull<readonly { id: string; name: string }[]>(
        `projects/${bug.project.id}/features`,
        bug.build ? { query: { buildId: bug.build.id } } : undefined,
      )
    : null

  // Internal notes are invisible to a tester by API design; this is belt and
  // braces so a shape change upstream can never leak one into the thread.
  const visibleComments = bug.comments.filter((c) => !c.isInternal)

  const reportItems: DescriptionItem[] = [
    {
      label: 'Reference',
      value: <span style={{ fontFamily: 'var(--font-mono)' }}>{bug.reference}</span>,
    },
    { label: 'Severity', value: <SeverityBadge severity={bug.severity} /> },
    { label: 'Type', value: bug.type ? titleCase(bug.type) : null },
    { label: 'Feature', value: bug.feature?.name ?? null },
    {
      label: 'Reproducibility',
      // The counted evidence beats the summary when it exists — "3 out of 5"
      // is what a triager can act on; the enum is a rounding of it.
      value:
        bug.occurrence !== null && bug.outOf !== null
          ? `${titleCase(bug.reproducibility)} · ${bug.occurrence} out of ${bug.outOf}`
          : titleCase(bug.reproducibility),
    },
    { label: 'Description', value: <Reported text={bug.description} />, wide: true },
    {
      label: 'Pre-condition',
      value: bug.preCondition ? <Reported text={bug.preCondition} /> : null,
      wide: true,
    },
    { label: 'Steps to reproduce', value: <Reported text={bug.stepsToReproduce} />, wide: true },
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

  const environmentItems: DescriptionItem[] = [
    { label: 'Device', value: bug.deviceModel },
    { label: 'OS', value: bug.osName },
    { label: 'OS version', value: bug.osVersion },
    { label: 'Browser', value: bug.browser },
    { label: 'App version', value: bug.appVersion },
    { label: 'Network', value: bug.networkType },
  ]

  /* Device, OS, browser and network options — the tester's own kit first,
     then the catalog. One loader, so the report form and the edit form
     cannot offer different environments for the same bug. */
  const environment = await loadBugEnvironmentOptions()
  const deviceOptions = environment.devices
  const osGroups = environment.osGroups
  const browserOptions = environment.browsers
  const networkOptions = environment.networks
  return (
    <DetailShell
      root={ROOT}
      crumbs={[
        { label: bug.project.title, href: `${projectHref}?section=bugs` },
        { label: bug.reference },
      ]}
      eyebrow="Work"
      title={bug.title}
      badges={
        <>
          <SeverityBadge severity={bug.severity} />
          <StatusBadge status={bug.status} />
        </>
      }
      subtitle={
        <>
          {bug.reference} · filed {formatDateTime(bug.createdAt)} on{' '}
          <Link href={projectHref} style={LINK_STYLE}>
            {bug.project.title}
          </Link>
          {bug.build ? ` · ${bug.build.name}` : ''}
        </>
      }
      tabs={
        <SectionTabs
          basePath={detailPath}
          tabs={SECTIONS.map((t) =>
            t.value === 'attachments'
              ? { ...t, count: bug.attachments.length }
              : t.value === 'comments'
                ? { ...t, count: visibleComments.length }
                : t,
          )}
          active={section}
        />
      }
      aside={
        <>
          <Panel
            title="Status"
            description="Where this report sits in the workflow."
            actions={
              transitions.length > 0 ? (
                <Button
                  href={`${detailPath}?section=${section}&edit=status`}
                  variant="primary"
                  size="sm"
                >
                  Change
                </Button>
              ) : undefined
            }
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
                      href={`${DETAIL_BASE}/${bug.duplicateOf.id}`}
                      style={{ ...LINK_STYLE, fontSize: 'var(--type-body-sm-size)' }}
                    >
                      {bug.duplicateOf.reference} — {bug.duplicateOf.title}
                    </Link>
                  ) : (
                    <Note>Marked a duplicate of a report you cannot see.</Note>
                  )}
                </div>
              ) : null}

              <StatusBadge status={bug.status} />

              {transitions.length === 0 ? (
                <Note>
                  There is nothing for you to change from {titleCase(bug.status).toLowerCase()}. The
                  project team moves it from here.
                </Note>
              ) : null}
            </div>
          </Panel>

          {transitions.length > 0 ? (
            <Modal open={statusModalOpen} closedHref={closedHref} title="Change status">
              <TrackedForm action={moveBugStatus} style={FORM_STYLE}>
                <input type="hidden" name="id" value={bug.id} />
                <FormError message={panelError(error, 'status')} />
                <Field
                  label="Move to"
                  htmlFor="status"
                  required
                  hint="Only the moves the platform will accept from you are listed."
                >
                  <Select
                    id="status"
                    name="status"
                    required
                    placeholder="Choose a move"
                    options={transitions.map((value) => ({ value, label: titleCase(value) }))}
                  />
                </Field>
                <Field
                  label="Note"
                  htmlFor="note"
                  hint="Recorded against the move. Say what you saw."
                >
                  <Textarea id="note" name="note" rows={4} maxLength={1000} />
                </Field>
                <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
                  Save status
                </SubmitButton>
              </TrackedForm>
            </Modal>
          ) : null}

          <Panel title="Details">
            <DescriptionList
              items={[
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
                  value: (
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{bug.project.reference}</span>
                  ),
                },
                { label: 'Reported by', value: personName(bug.reportedBy) },
                { label: 'Reported', value: formatDate(bug.createdAt) },
                { label: 'Triaged', value: formatDate(bug.triagedAt) },
                { label: 'Resolved', value: formatDate(bug.resolvedAt) },
                { label: 'Last updated', value: formatDate(bug.updatedAt) },
              ]}
            />
          </Panel>
        </>
      }
    >
      {section === 'report' ? (
        <Panel
          title="Report"
          description="The defect as you filed it."
          actions={
            capabilities.canEdit ? (
              <Button
                href={`${detailPath}?section=${section}&edit=edit-report`}
                variant="primary"
                size="sm"
                iconLeft="pencil"
              >
                Edit
              </Button>
            ) : undefined
          }
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

      {capabilities.canEdit ? (
        <Modal open={reportModalOpen} closedHref={closedHref} title="Edit report">
          <TrackedForm action={updateBugAction} style={FORM_STYLE}>
            <input type="hidden" name="id" value={bug.id} />
            {/*
              The report panel is the one with nineteen fields, so a bare
              "the API rejected that" left the reader hunting. When the API
              named a field, the hint says which — in this page's own words,
              from a token the map above has to recognise.
            */}
            <FormError
              message={(() => {
                const base = panelError(error, 'report')
                if (!base) return undefined
                // Only the generic rejection gains a field hint; the specific
                // reasons already say exactly what is wrong.
                return error?.endsWith(':invalid') ? `${base}${fieldHint(field)}` : base
              })()}
            />

            <Field label="Title" htmlFor="editTitle" required>
              <Input
                id="editTitle"
                name="title"
                required
                minLength={5}
                maxLength={200}
                defaultValue={bug.title}
              />
            </Field>
            <Field label="Description" htmlFor="editDescription" required>
              <Textarea
                id="editDescription"
                name="description"
                rows={4}
                required
                minLength={10}
                maxLength={10_000}
                defaultValue={bug.description}
              />
            </Field>
            <Field label="Pre-condition" htmlFor="editPreCondition">
              <Textarea
                id="editPreCondition"
                name="preCondition"
                rows={2}
                maxLength={4000}
                defaultValue={bug.preCondition ?? ''}
              />
            </Field>
            <Field label="Steps to reproduce" htmlFor="editStepsToReproduce" required>
              <Textarea
                id="editStepsToReproduce"
                name="stepsToReproduce"
                rows={6}
                required
                minLength={5}
                maxLength={10_000}
                defaultValue={bug.stepsToReproduce}
              />
            </Field>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              <Field label="Expected result" htmlFor="editExpectedResult" required>
                <Textarea
                  id="editExpectedResult"
                  name="expectedResult"
                  rows={3}
                  required
                  minLength={5}
                  maxLength={4000}
                  defaultValue={bug.expectedResult ?? ''}
                />
              </Field>
              <Field label="Actual result" htmlFor="editActualResult" required>
                <Textarea
                  id="editActualResult"
                  name="actualResult"
                  rows={3}
                  required
                  minLength={5}
                  maxLength={4000}
                  defaultValue={bug.actualResult ?? ''}
                />
              </Field>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              <Field label="Severity" htmlFor="editSeverity" required>
                <Select
                  id="editSeverity"
                  name="severity"
                  required
                  defaultValue={bug.severity}
                  options={SEVERITIES.map((value) => ({ value, label: titleCase(value) }))}
                />
              </Field>
              <Field label="Reproducibility" htmlFor="editReproducibility" required>
                <Select
                  id="editReproducibility"
                  name="reproducibility"
                  required
                  defaultValue={bug.reproducibility}
                  options={BUG_REPRODUCIBILITIES.map((value) => ({
                    value,
                    label: titleCase(value),
                  }))}
                />
              </Field>
              <Field
                label="Times it happened"
                htmlFor="editOccurrence"
                hint="Optional. Leave both blank if you didn't count."
              >
                <Input
                  id="editOccurrence"
                  name="occurrence"
                  type="number"
                  min={0}
                  max={10_000}
                  defaultValue={bug.occurrence ?? ''}
                />
              </Field>
              <Field
                label="Out of attempts"
                htmlFor="editOutOf"
                hint="Optional, but required if you filled the field to the left."
              >
                <Input
                  id="editOutOf"
                  name="outOf"
                  type="number"
                  min={1}
                  max={10_000}
                  defaultValue={bug.outOf ?? ''}
                />
              </Field>
              <Field label="Type" htmlFor="editType" hint="Optional.">
                <Select
                  id="editType"
                  name="type"
                  defaultValue={bug.type ?? ''}
                  options={[
                    { value: '', label: 'Not sure' },
                    ...BUG_TYPES.map((value) => ({ value, label: titleCase(value) })),
                  ]}
                />
              </Field>
              {features && features.length > 0 ? (
                <Field label="Feature" htmlFor="editFeatureId" hint="Optional.">
                  <Select
                    id="editFeatureId"
                    name="featureId"
                    defaultValue={bug.feature?.id ?? ''}
                    options={[
                      { value: '', label: 'Not sure' },
                      ...features.map((f) => ({ value: f.id, label: f.name })),
                    ]}
                  />
                </Field>
              ) : null}
            </div>

            <h3 className="c4t-heading-sm" style={{ margin: 0 }}>
              Where you saw it
            </h3>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              {/*
                The environment, from lists rather than six text boxes. Editing an
                old report must not rewrite what it was found on, so a stored value
                the catalog no longer offers is kept — see `PairSelect`.
              */}
              <Field label="Device" htmlFor="editDeviceModel">
                <Select
                  id="editDeviceModel"
                  name="deviceModel"
                  defaultValue={bug.deviceModel ?? ''}
                  options={deviceOptions}
                  placeholder="Not specified"
                />
              </Field>
              <PairSelect
                groups={osGroups}
                parentName="osName"
                childName="osVersion"
                parentLabel="OS"
                childLabel="OS version"
                defaultParent={bug.osName}
                defaultChild={bug.osVersion}
                idPrefix="edit-bug-os"
                emptyHint="The device catalog is unavailable right now."
              />
              <Field label="Browser" htmlFor="editBrowser">
                <Select
                  id="editBrowser"
                  name="browser"
                  defaultValue={bug.browser ?? ''}
                  options={browserOptions}
                  placeholder="Not applicable"
                />
              </Field>
              {/* App version stays text: the customer's own build number. */}
              <Field label="App version" htmlFor="editAppVersion">
                <Input
                  id="editAppVersion"
                  name="appVersion"
                  maxLength={60}
                  defaultValue={bug.appVersion ?? ''}
                />
              </Field>
              <Field label="Network" htmlFor="editNetworkType">
                <Select
                  id="editNetworkType"
                  name="networkType"
                  defaultValue={bug.networkType ?? ''}
                  options={networkOptions}
                  placeholder="Not specified"
                />
              </Field>
            </div>

            <Field
              label="Video link"
              htmlFor="editVideoUrl"
              hint="A publicly reachable recording — Loom, Drive, anything the team can open without an account."
            >
              <Input
                id="editVideoUrl"
                name="videoUrl"
                type="url"
                maxLength={2000}
                defaultValue={bug.videoUrl ?? ''}
              />
            </Field>

            <SubmitButton variant="primary" fullWidth pendingLabel="Saving…">
              Save report
            </SubmitButton>
          </TrackedForm>
        </Modal>
      ) : null}

      {section === 'attachments' ? (
        <Panel
          title="Evidence"
          description="Screenshots and recordings filed with this report. Links are signed and short-lived."
        >
          {bug.videoUrl ? (
            <p style={{ margin: '0 0 var(--space-5)' }}>
              <a
                href={bug.videoUrl}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  ...LINK_STYLE,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                }}
              >
                <Icon name="video" size={16} />
                Watch the recording
              </a>
            </p>
          ) : null}

          {bug.attachments.length === 0 ? (
            <Note>
              {bug.videoUrl
                ? 'No files were attached — the recording above is the evidence on this report.'
                : 'No evidence was attached to this report.'}
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
                    gap: 'var(--space-4)',
                    padding: 'var(--space-4) var(--space-5)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-card)',
                  }}
                >
                  <Icon
                    name={attachment.file.mimeType.startsWith('image/') ? 'image' : 'file-text'}
                    size={20}
                    style={{
                      color: 'var(--text-muted)',
                      marginTop: 'var(--space-1)',
                      flex: 'none',
                    }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <a
                      href={attachment.file.downloadUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ ...LINK_STYLE, wordBreak: 'break-word' }}
                    >
                      {attachment.file.originalName}
                    </a>
                    <span
                      style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}
                    >
                      {formatBytes(attachment.file.sizeBytes)} · {attachment.file.mimeType} · added{' '}
                      {formatDate(attachment.createdAt)}
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
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      {section === 'comments' ? (
        <Panel title="Comments" description="The conversation on this defect.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {visibleComments.length === 0 ? (
              <Note>No comments yet. Add anything that would help someone reproduce this.</Note>
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
                {visibleComments.map((comment) => (
                  <li
                    key={comment.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-5)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-card)',
                      background: 'var(--surface-canvas)',
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
                      <span
                        style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}
                      >
                        {formatDateTime(comment.createdAt)}
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
                  placeholder="Add a build number, a second device you saw it on, anything that helps."
                />
              </Field>
              <div>
                <SubmitButton
                  variant="primary"
                  disabled={!capabilities.canComment}
                  pendingLabel="Posting…"
                >
                  Post comment
                </SubmitButton>
              </div>
            </form>
          </div>
        </Panel>
      ) : null}

      {section === 'history' ? (
        <Panel title="Status history" description="Every move on this report, oldest first.">
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
                      style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}
                    >
                      {personName(entry.changedBy)} · {formatDateTime(entry.createdAt)}
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
      ) : null}
    </DetailShell>
  )
}

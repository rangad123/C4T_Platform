import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { InboxList } from '@/components/admin/InboxList'
import { MarkReadOnView } from '@/components/admin/MarkReadOnView'
import {
  buildAnnouncementItems,
  loadBroadcastReads,
  type BroadcastReads,
} from '@/lib/communication/inbox'
import { Modal } from '@/components/admin/Modal'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { Panel } from '@/components/admin/Panel'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { DescriptionList, type DescriptionItem } from '@/components/admin/DescriptionList'
import { StatusBadge, SeverityBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { formatDate, formatDateTime, personName, titleCase } from '@/lib/admin/format'
import { BuildSwitcher } from '@/components/admin/BuildSwitcher'
import {
  BUILD_STATUSES,
  PROJECT_PRIORITIES,
  allowedTransitions,
  isProjectPriority,
  type AnnouncementRow,
  type BugCustomFieldRow,
  type BuildDetail,
  type BuildSummary,
  type ProjectBugRow,
  type ProjectDetail,
  type ProjectMaterial,
  type ProjectRatingRow,
  type ProjectReportSummary,
  BUG_FIELD_TYPE_LABEL,
} from './constants'
import { BugBreakdownView } from '@/components/admin/BugBreakdownView'
import { CustomFieldForm } from '@/components/admin/CustomFieldForm'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { BarChart } from '@/components/admin/charts/BarChart'
import { DonutChart } from '@/components/admin/charts/DonutChart'
import {
  addFeature,
  addMaterial,
  changeProjectStatus,
  createBuild,
  removeFeature,
  removeMaterial,
  renameBuild,
  updateBuild,
  copyBuild,
  updateProjectBrief,
  updateProjectDelivery,
  setBugCustomization,
  addBugCustomField,
  removeBugCustomField,
} from './actions'
/*
 * The one rating action, shared with the tester's own profile page. Imported
 * across rather than copied so both doors post the same body to the same
 * endpoint and cannot drift apart.
 */
import { rateTesterAction } from '../../crowdtesters/[id]/actions'

const ROOT = { label: 'Customer', href: '/app/customer' }
const BUG_PREVIEW_SIZE = 10

/**
 * `/app/customer/projects/[id]` — the customer's own project workbench.
 *
 * Subset of `admin/projects/[id]/page.tsx`: same shell, same section-gated
 * fetch pattern (each Promise.all entry conditional on the active tab, so
 * opening one tab never waits on another's data), same `capabilities.*`
 * flags from the API (already generic per-caller — no new logic needed
 * here). Drops the Testers tab (`project:assign_testers` never applies to a
 * customer, `canAssignTesters` is always false) and Settings/Archive
 * (`project.delete` never applies either).
 */

/**
 * Strips zero-count categories out of a distribution.
 *
 * `reports/by-build` returns every enum member, including the ones with no
 * bugs — so a status chart would draw ten bars, eight of them empty. The
 * project-level endpoint already omits zeros, so dropping them here makes the
 * two views read the same.
 */
function dropZeros(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0))
}

const NOTICES: Record<string, NoticeCopy> = {
  created: {
    tone: 'success',
    message: 'Your project is set up. Testing can begin once it is approved.',
  },
  'build-incomplete': {
    tone: 'warning',
    message:
      'The project was created, but its first build still needs its details. Open Build details to finish it.',
  },
  'field-added': { tone: 'success', message: 'That field is now on the bug form for this build.' },
  'field-removed': { tone: 'success', message: 'That field has been removed.' },
  'field-exists': { tone: 'warning', message: 'A field with that name is already on this build.' },
  'field-invalid': {
    tone: 'error',
    message:
      'That field could not be added. A choice field needs at least one option, and options must differ.',
  },
  'field-failed': {
    tone: 'error',
    message: 'That field could not be added. Try again in a moment.',
  },
  'build-renamed': { tone: 'success', message: 'The build has been renamed.' },
  'build-name-taken': {
    tone: 'warning',
    message: 'That build name is already used on this project. Choose another name.',
  },
  'build-rename-failed': {
    tone: 'error',
    message: 'The build could not be renamed. Try again in a moment.',
  },
  'build-saved': { tone: 'success', message: 'Build details saved.' },
  'build-save-failed': {
    tone: 'error',
    message: 'Those build details could not be saved. Try again in a moment.',
  },
  'build-created': { tone: 'success', message: 'The build has been created.' },
  'build-create-failed': {
    tone: 'error',
    message: 'That build could not be created. Try again in a moment.',
  },
  'build-copied': {
    tone: 'success',
    message: 'The build was copied. Its settings are here, ready to adjust.',
  },
  'build-copy-failed': {
    tone: 'error',
    message: 'Unable to copy this build. Please try again.',
  },
  'brief-saved': { tone: 'success', message: 'The brief has been updated.' },
  'brief-save-failed': {
    tone: 'error',
    message: 'The brief could not be saved. Try again in a moment.',
  },
  'rating-saved': { tone: 'success', message: 'Thanks — your rating has been recorded.' },
  'rating-duplicate': {
    tone: 'warning',
    message: 'You have already rated this tester on this project.',
  },
  'rating-not-worked-together': {
    tone: 'warning',
    message: 'You can only rate a tester once they have actually worked on this project.',
  },
  'rating-needs-project': { tone: 'warning', message: 'Choose which work you are rating.' },
  'rating-invalid': { tone: 'warning', message: 'Give a score between 1 and 5.' },
  'rating-forbidden': { tone: 'error', message: 'You are not allowed to rate this tester.' },
  'rating-failed': {
    tone: 'error',
    message: 'That rating could not be saved. Try again in a moment.',
  },
  'settings-saved': { tone: 'success', message: 'That setting has been saved.' },
  'settings-save-failed': {
    tone: 'error',
    message: 'That setting could not be saved. Try again in a moment.',
  },
}

/**
 * Overview and Summary were one view split across three places.
 *
 * "Build details" carried its own metrics panel, a separate "Summary" tab
 * carried the same build's bug breakdown from a different endpoint, and
 * "Overview" carried a third set of the same counts at project level. Bugs
 * by severity and by status were each drawn twice for the same build, from
 * two sources that could disagree, and nothing said which was authoritative.
 *
 * They are now one Dashboard: metrics and charts here, configuration in
 * Build details, and each chart drawn exactly once.
 *
 * Dashboard is deliberately first — `resolveSection` falls back to the first
 * tab, so old `?section=overview` and `?section=summary` links land here
 * rather than 404ing or rendering an empty tab.
 */
/** Wording for each score, so the number is not the only cue. */
const RATING_SCORE_LABEL: Record<number, string> = {
  5: 'Excellent',
  4: 'Good',
  3: 'Adequate',
  2: 'Below par',
  1: 'Poor',
}

const SECTIONS = [
  { value: 'dashboard', label: 'Dashboard', icon: 'line-chart' },
  { value: 'build', label: 'Build details', icon: 'clock' },
  { value: 'testers', label: 'Testers', icon: 'users' },
  { value: 'materials', label: 'Materials', icon: 'book-open' },
  { value: 'features', label: 'Features', icon: 'layout-grid' },
  { value: 'bugs', label: 'Bugs', icon: 'clipboard-check' },
  { value: 'announcements', label: 'Announcements', icon: 'message-square' },
  { value: 'settings', label: 'Settings', icon: 'settings' },
] as const

export default async function CustomerProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    section?: string
    edit?: string
    buildId?: string
    notice?: string
    /** The tester being rated, when the rating dialog is open. */
    rate?: string
    announcement?: string
    /** Echoed back when a rename is rejected, so the attempt isn't retyped. */
    name?: string
  }>
}) {
  // Needed to tell my own ratings apart from anyone else's on this project.
  const sessionUser = await requireRole(['CUSTOMER'])
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const edit = resolvedSearchParams.edit
  const buildId = resolvedSearchParams.buildId

  let project: ProjectDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    project = await serverFetch<ProjectDetail>(`projects/${id}`, { query: { buildId } })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    if (err instanceof ApiError && err.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError !== null || project === null) {
    return (
      <DetailShell
        root={ROOT}
        crumbs={[
          { label: 'Projects', href: '/app/customer/projects' },
          { label: loadError === 'forbidden' ? 'Restricted' : 'Unavailable' },
        ]}
        eyebrow="Delivery"
        title={loadError === 'forbidden' ? 'Restricted' : 'Unavailable'}
      >
        {loadError === 'forbidden' ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this project"
            description="This project doesn't belong to your organisation."
            action={
              <Button variant="secondary" href="/app/customer/projects">
                Back to projects
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load this project"
            description="The projects service is unreachable. Refresh in a moment."
            action={
              <Button variant="secondary" href="/app/customer/projects">
                Back to projects
              </Button>
            }
          />
        )}
      </DetailShell>
    )
  }

  const { capabilities } = project
  const activeBuildId = project.activeBuildId
  const defaultBuildId = project.builds.find((b) => b.isDefault)?.id ?? activeBuildId

  const buildDetail = await serverFetchOrNull<BuildDetail>(
    `projects/${project.id}/builds/${activeBuildId}`,
  )
  const section = resolveSection(SECTIONS, resolvedSearchParams.section)
  const newBuildModalOpen = edit === 'new-build'

  const [
    buildSummaryData,
    features,
    bugs,
    projectReport,
    defaultBuildDetailIfDifferent,
    projectRatings,
    reads,
    announcements,
    customFields,
  ] = await Promise.all([
    /**
     * Everything build-shaped on the Dashboard comes from this one endpoint.
     *
     * `BuildSummary` already carries the type and reproducibility breakdowns
     * that `reports/by-build` returns, plus test-report results and review
     * ratings that it does not — it is a superset. The Summary tab was
     * fetching the second endpoint for charts this one could already draw,
     * which is how the same build ended up with two sets of bug charts.
     */
    section === 'dashboard'
      ? serverFetchOrNull<BuildSummary>(`builds/${activeBuildId}/summary`)
      : Promise.resolve(null),
    section === 'features'
      ? serverFetchOrNull<
          readonly { id: string; name: string; createdAt: string; _count: { bugs: number } }[]
        >(`projects/${project.id}/features`, { query: { buildId: activeBuildId } })
      : Promise.resolve(null),
    section === 'bugs'
      ? serverFetchOrNull<ProjectBugRow[]>('bugs', {
          query: { projectId: project.id, buildId: activeBuildId, limit: BUG_PREVIEW_SIZE },
        })
      : Promise.resolve(null),
    /**
     * Project-level context for the Dashboard: where the crowd is based, and
     * totals across every build rather than the selected one. Nothing here
     * overlaps the build summary above — that is the point of keeping both.
     */
    section === 'dashboard'
      ? serverFetchOrNull<ProjectReportSummary>(`reports/by-project/${project.id}`)
      : Promise.resolve(null),
    newBuildModalOpen && defaultBuildId !== activeBuildId
      ? serverFetchOrNull<BuildDetail>(`projects/${project.id}/builds/${defaultBuildId}`)
      : Promise.resolve(null),
    /**
     * Announcements for this project and build. The context filters are the
     * API's, so this cannot show another organisation's notices — and a
     * build-scoped announcement only appears on the build it was written for.
     */
    /**
     * Ratings already on this project, so a tester the viewer has rated shows
     * that instead of a button the API would only reject.
     */
    section === 'testers'
      ? serverFetchOrNull<readonly ProjectRatingRow[]>('ratings', {
          query: { projectId: project.id, subjectType: 'TESTER', limit: 100 },
        })
      : Promise.resolve(null),
    section === 'announcements'
      ? loadBroadcastReads()
      : Promise.resolve<BroadcastReads>({
          unreadIds: new Set<string>(),
          notificationIdFor: new Map<string, string>(),
        }),
    section === 'announcements'
      ? serverFetchOrNull<readonly AnnouncementRow[]>('communication/announcements', {
          query: { projectId: project.id, buildId: activeBuildId, limit: 50 },
        })
      : Promise.resolve(null),
    // The build's own extra bug questions (§37).
    section === 'settings'
      ? serverFetchOrNull<readonly BugCustomFieldRow[]>(`projects/${project.id}/custom-fields`, {
          query: { buildId: activeBuildId },
        })
      : Promise.resolve(null),
  ])
  const defaultBuildDetail =
    defaultBuildId !== activeBuildId ? defaultBuildDetailIfDifferent : buildDetail

  const priority = isProjectPriority(project.priority) ? project.priority : 'NORMAL'
  const transitions = allowedTransitions(project.status)
  const detailPath = `/app/customer/projects/${project.id}`
  const closedHref = (() => {
    const sp = new URLSearchParams()
    if (section !== SECTIONS[0].value) sp.set('section', section)
    if (buildId) sp.set('buildId', buildId)
    const qs = sp.toString()
    return qs ? `${detailPath}?${qs}` : detailPath
  })()
  const briefModalOpen = edit === 'brief'
  const buildDetailsModalOpen = edit === 'build-details'
  const activeBuild = project.builds.find((b) => b.id === activeBuildId)

  /**
   * The roster, as the customer is allowed to see it.
   *
   * No email column: the API stops sending tester addresses to a customer, so
   * there is nothing to render even if this asked for one. Rating and country
   * come from the tester's profile and are what a client actually uses to
   * judge coverage.
   */
  /**
   * Who this viewer has already rated on this project.
   *
   * Filtered to their OWN ratings: the list carries every rating they may
   * see, and someone else's rating of the same tester does not use up their
   * turn.
   */
  const ratedByMe = new Set(
    (projectRatings ?? [])
      .filter((r) => r.author?.id === sessionUser.id && r.subjectUser?.id)
      .map((r) => r.subjectUser!.id),
  )

  /** Mirrors `assertWorkedTogether` on the API: an invitation is not work. */
  const RATEABLE = new Set(['ACTIVE', 'COMPLETED'])

  // The assignment the rating dialog is open for, if any.
  const announcementItems = buildAnnouncementItems({
    basePath: detailPath,
    announcements: announcements ?? [],
    reads,
    // Keep the tab and the build, or opening a notice would drop the reader
    // back on the project's first section against a different build.
    carry: { section: 'announcements', buildId: activeBuildId },
  })

  const openAnnouncement = resolvedSearchParams.announcement
    ? ((announcements ?? []).find((a) => a.id === resolvedSearchParams.announcement) ?? null)
    : null

  const ratingTarget = resolvedSearchParams.rate
    ? project.assignments.find((a) => a.tester.id === resolvedSearchParams.rate)
    : undefined

  const testerColumns: readonly TableColumn<ProjectDetail['assignments'][number]>[] = [
    {
      key: 'tester',
      header: 'Tester',
      render: (row) =>
        [row.tester.firstName, row.tester.lastName].filter(Boolean).join(' ') || 'Tester',
      renderSecondary: (row) =>
        row.tester.testerProfile?.countryCode
          ? `From ${row.tester.testerProfile.countryCode}`
          : undefined,
    },
    {
      key: 'status',
      header: 'Standing',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'rating',
      header: 'Rating',
      align: 'right',
      render: (row) => {
        const raw = row.tester.testerProfile?.ratingAverage
        if (raw == null) return '—'
        const value = Number(raw)
        return Number.isFinite(value) ? value.toFixed(1) : '—'
      },
    },
    {
      key: 'invited',
      header: 'Invited',
      align: 'right',
      render: (row) => formatDate(row.invitedAt),
      renderSecondary: (row) =>
        row.completedAt
          ? `Finished ${formatDate(row.completedAt)}`
          : row.respondedAt
            ? `Responded ${formatDate(row.respondedAt)}`
            : undefined,
    },
    /**
     * Rating the work, from the work.
     *
     * The other entry point is the tester's own profile; both post through
     * `rateTesterAction` to the same endpoint, so there is one rating system
     * with two doors rather than two implementations to keep in step.
     *
     * Hidden where the API would refuse it — already rated, or an invitation
     * never taken up — so this is never a button whose only outcome is an
     * error. `interactive` keeps the cell out of the row's own link.
     */
    {
      key: 'rate',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) =>
        ratedByMe.has(row.tester.id) ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
            Rated
          </span>
        ) : RATEABLE.has(row.status) ? (
          <Button
            href={`${detailPath}?section=testers&buildId=${activeBuildId}&rate=${row.tester.id}`}
            variant="ghost"
            size="sm"
            iconLeft="star"
          >
            Rate
          </Button>
        ) : null,
    },
  ]

  const customFieldColumns: readonly TableColumn<BugCustomFieldRow>[] = [
    { key: 'name', header: 'Field', render: (row) => row.name },
    {
      key: 'type',
      header: 'Type',
      render: (row) => BUG_FIELD_TYPE_LABEL[row.type] ?? titleCase(row.type),
      renderSecondary: (row) => (row.isRequired ? 'Required' : undefined),
    },
    {
      key: 'options',
      header: 'Options',
      render: (row) => (row.options.length > 0 ? row.options.join(', ') : '—'),
    },
    {
      key: 'action',
      header: 'Action',
      align: 'right',
      render: (row) =>
        capabilities.canManageMaterials ? (
          <form action={removeBugCustomField}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="buildId" value={activeBuildId} />
            <input type="hidden" name="fieldId" value={row.id} />
            {/*
              The answer count is in the question because deleting a field
              deletes its answers — a client should know they are discarding
              data, not just a label.
            */}
            <ConfirmSubmit
              question={
                row._count.values > 0
                  ? `Remove ${row.name}? ${row._count.values} answer${row._count.values === 1 ? '' : 's'} already given will go with it.`
                  : `Remove ${row.name}?`
              }
            >
              Remove
            </ConfirmSubmit>
          </form>
        ) : (
          '—'
        ),
    },
  ]

  /**
   * What the brief shows: only what Build details does not.
   *
   * Window, target countries, target languages and testing instructions used
   * to appear here AND on Build details. They are not two facts that happen
   * to agree — the wizard writes the same answers to the project and to its
   * first build, so the two panels restated one input, and after a build was
   * edited they disagreed with no way to tell which one governed. The build's
   * copy is the one that governs: it is what the tester's project page reads
   * and what each test cycle actually runs to.
   *
   * So the brief keeps what is true of the project and nothing else — who it
   * is, where it is in its lifecycle, the platforms in scope, and the ask.
   * `summary` carries the same text the removed instructions did, because the
   * wizard fills both from one field, so nothing readable is lost.
   *
   * The project's own columns are untouched and still edited by "Edit the
   * brief" — they feed the tester-facing project window and the admin CSV
   * export. That modal already sets several things this list does not show
   * (title, max testers, bug visibility); this is the same split, not a new
   * one.
   */
  const overview: DescriptionItem[] = [
    { label: 'Reference', value: <Mono>{project.reference}</Mono> },
    { label: 'Priority', value: titleCase(project.priority) },
    { label: 'Created', value: formatDate(project.createdAt) },
    { label: 'Last updated', value: formatDate(project.updatedAt) },
    { label: 'Submitted', value: formatDate(project.submittedAt) },
    { label: 'Approved', value: formatDate(project.approvedAt) },
    { label: 'Completed', value: formatDate(project.completedAt) },
    { label: 'Platform targets', value: <TokenList values={project.platformTargets} /> },
    {
      label: 'Summary',
      wide: true,
      value: project.summary ? <Prose>{project.summary}</Prose> : '',
    },
  ]

  const bugColumns: readonly TableColumn<ProjectBugRow>[] = [
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) => row.reference,
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (row) => <SeverityBadge severity={row.severity} />,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'logged', header: 'Logged', align: 'right', render: (row) => formatDate(row.createdAt) },
  ]

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Projects', href: '/app/customer/projects' }, { label: project.reference }]}
      eyebrow="Delivery"
      title={project.title}
      badges={<StatusBadge status={project.status} />}
      subtitle={`${project.reference} · created ${formatDate(project.createdAt)}`}
      tabs={
        /*
         * The build picker sits ABOVE the tabs, not beside them.
         *
         * Every tab below is scoped to the selected build, so the choice is
         * not one tab's control — it frames all of them. Sharing a row with
         * the tabs also made it the first thing to wrap off a narrow screen,
         * which is the opposite of what its importance deserves.
         */
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          {/* Wraps: the build name is user-supplied and unbounded, and beside
              the buttons it pushed this row past a phone viewport. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <BuildSwitcher
              basePath={detailPath}
              builds={project.builds}
              activeBuildId={activeBuildId}
            />
            {capabilities.canUpdate ? (
              <>
                <Button
                  href={`${detailPath}?section=${section}&buildId=${activeBuildId}&edit=rename-build`}
                  variant="primary"
                  size="sm"
                >
                  Rename
                </Button>
                <Button
                  href={`${detailPath}?section=${section}&buildId=${activeBuildId}&edit=new-build`}
                  variant="primary"
                  size="sm"
                  iconLeft="plus"
                >
                  New build
                </Button>
              </>
            ) : null}
          </div>

          <SectionTabs
            basePath={detailPath}
            tabs={SECTIONS}
            active={section}
            preserve={{ buildId }}
          />
        </div>
      }
      aside={
        /*
         * Where the two editable project panels live.
         *
         * Status and Priority were on the Dashboard, which is a place to READ
         * how the work is going — putting the controls that change it there
         * mixed reporting with administration. They sit with Build details
         * now, the tab that already exists for looking after the project
         * rather than watching it.
         *
         * "At a glance" stays on the Dashboard: it is three counts, which is
         * reporting, not administration.
         */
        section === 'build' ? (
          <>
            <Panel
              title="Status"
              description={`Now ${titleCase(project.status).toLowerCase()}. Only legal moves are listed.`}
            >
              {!capabilities.canChangeStatus ? (
                <Muted>You can read this project but not move it.</Muted>
              ) : transitions.length === 0 ? (
                <Muted>
                  A cancelled project is closed for good. Raise a new one to run this scope again.
                </Muted>
              ) : (
                <form action={changeProjectStatus} style={stackStyle}>
                  <input type="hidden" name="id" value={project.id} />
                  <Field label="Move to" htmlFor="status-next">
                    <Select
                      id="status-next"
                      name="status"
                      required
                      defaultValue={transitions[0]}
                      options={transitions.map((value) => ({ value, label: titleCase(value) }))}
                    />
                  </Field>
                  <Field label="Note" htmlFor="status-note" hint="Recorded on the audit trail.">
                    <Textarea
                      id="status-note"
                      name="note"
                      rows={3}
                      placeholder="Why is it moving?"
                      maxLength={1000}
                    />
                  </Field>
                  <SubmitButton variant="primary" fullWidth pendingLabel="Changing status…">
                    Change status
                  </SubmitButton>
                </form>
              )}
            </Panel>

            <Panel
              title="Priority and progress"
              description="Progress is the figure your delivery team reports, not a computed one."
            >
              {capabilities.canUpdate ? (
                <form action={updateProjectDelivery} style={stackStyle}>
                  <input type="hidden" name="id" value={project.id} />
                  <Field label="Priority" htmlFor="priority">
                    <Select
                      id="priority"
                      name="priority"
                      defaultValue={priority}
                      options={PROJECT_PRIORITIES.map((value) => ({
                        value,
                        label: titleCase(value),
                      }))}
                    />
                  </Field>
                  <Field label="Progress" htmlFor="progress" hint="A whole percentage, 0 to 100.">
                    <Input
                      id="progress"
                      name="progressPercent"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      defaultValue={project.progressPercent}
                    />
                  </Field>
                  <ProgressBar percent={project.progressPercent} />
                  <SubmitButton variant="secondary" fullWidth pendingLabel="Saving…">
                    Save priority and progress
                  </SubmitButton>
                </form>
              ) : (
                <div style={stackStyle}>
                  <ProgressBar percent={project.progressPercent} />
                </div>
              )}
            </Panel>
          </>
        ) : section === 'dashboard' ? (
          <>
            <Panel title="At a glance">
              <DescriptionList
                items={[
                  { label: 'Testers on the roster', value: String(project._count.assignments) },
                  { label: 'Bugs logged', value: String(project._count.bugs) },
                  { label: 'Materials attached', value: String(project._count.materials) },
                ]}
              />
            </Panel>

            {/* ── Project brief ───────────────────────────────
                In the aside rather than under the charts. Once the fields
                Build details already carried came out, what is left is nine
                short facts -- a reference, where the project sits in its
                lifecycle, the platforms in scope, and the ask. That is
                reference material, not analysis: it reads fine in a narrow
                column, whereas the charts it used to sit below genuinely
                need the width. It also fills the space that sat empty under
                "At a glance".

                Still on the Dashboard rather than Build details: these are
                facts about the project itself, and filing them under a
                single build would misattribute them. See `overview` for what
                was removed from this list and why.

                The "Edit the brief" modal stays in the main column below --
                a <dialog> renders the same wherever it sits, and the aside
                is for what is read, not for what is only sometimes open. */}
            <Panel
              title="Project brief"
              description="Facts about the project itself. Per-cycle detail is in Build details."
              actions={
                capabilities.canUpdate ? (
                  <Button
                    // Carries the selected build, like every other link here.
                    // Without it, opening the brief silently reset the picker
                    // to the default build.
                    href={`${detailPath}?section=${section}&buildId=${activeBuildId}&edit=brief`}
                    variant="primary"
                    size="sm"
                  >
                    Edit
                  </Button>
                ) : undefined
              }
            >
              <DescriptionList items={overview} />
            </Panel>
          </>
        ) : undefined
      }
    >
      <Notice code={resolvedSearchParams.notice} notices={NOTICES} />

      {section === 'dashboard' ? (
        <>
          {/* ── Key metrics ───────────────────────────────────────────────
              The selected build's headline numbers. Everything below reads
              as detail on these four, so they lead. */}
          <Panel
            title="Key metrics"
            description={`Where ${activeBuild?.name ?? 'this build'} stands right now.`}
          >
            {!buildSummaryData ? (
              <Muted>These metrics could not be loaded. Refresh in a moment.</Muted>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: 'var(--space-4)',
                }}
              >
                {[
                  { label: 'Testers', value: String(buildSummaryData.testerCount) },
                  { label: 'Bugs', value: String(buildSummaryData.bugCount) },
                  { label: 'Test cases', value: String(buildSummaryData.testCaseCount) },
                  {
                    label: 'Test completion',
                    value:
                      buildSummaryData.testCaseCompletion === null
                        ? '—'
                        : `${buildSummaryData.testCaseCompletion}%`,
                  },
                ].map((kpi) => (
                  <div
                    key={kpi.label}
                    style={{
                      padding: 'var(--space-5)',
                      border: '1px solid var(--border-default)',
                      borderRadius: 'var(--radius-card)',
                      background: 'var(--surface-raised)',
                    }}
                  >
                    <p className="c4t-eyebrow" style={{ margin: 0, color: 'var(--text-muted)' }}>
                      {kpi.label}
                    </p>
                    <p
                      style={{
                        margin: 'var(--space-2) 0 0',
                        fontSize: 'var(--type-display-sm-size)',
                        fontWeight: 'var(--fw-semibold)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {kpi.value}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* ── Bug overview ──────────────────────────────────────────────
              One breakdown, four cuts, from one source. This replaces the
              severity/status charts the build tab drew and the separate set
              the Summary tab drew from a different endpoint. */}
          <Panel title="Bug overview" description="How the bugs found on this build break down.">
            {!buildSummaryData ? (
              <Muted>This breakdown could not be loaded. Refresh in a moment.</Muted>
            ) : buildSummaryData.bugCount === 0 ? (
              <Muted>No bugs have been reported on this build yet.</Muted>
            ) : (
              <BugBreakdownView
                bugs={{
                  total: buildSummaryData.bugCount,
                  bySeverity: dropZeros(buildSummaryData.bugsBySeverity),
                  byStatus: dropZeros(buildSummaryData.bugsByStatus),
                  byType: dropZeros(buildSummaryData.bugsByType),
                  byReproducibility: dropZeros(buildSummaryData.bugsByReproducibility),
                }}
                csvHref={`/app/customer/export/reports/by-build/${activeBuildId}/export.csv`}
              />
            )}
          </Panel>

          {/* ── Testing progress ──────────────────────────────────────────
              Execution rather than defects: what the test runs returned. */}
          <Panel
            title="Testing progress"
            description="What the test runs on this build have returned so far."
          >
            {!buildSummaryData ? (
              <Muted>Progress could not be loaded. Refresh in a moment.</Muted>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
                <DonutChart
                  title="Test reports by result"
                  centerLabel={String(
                    Object.values(buildSummaryData.testReportsByResult).reduce((a, b) => a + b, 0),
                  )}
                  segments={Object.entries(buildSummaryData.testReportsByResult).map(
                    ([label, value]) => ({
                      label: titleCase(label),
                      value,
                      tone:
                        label === 'PASS'
                          ? 'success'
                          : label === 'FAIL'
                            ? 'error'
                            : label === 'BLOCKED'
                              ? 'warning'
                              : 'neutral',
                    }),
                  )}
                />
                {buildSummaryData.reviewCount > 0 ? (
                  <p
                    style={{
                      margin: 0,
                      color: 'var(--text-secondary)',
                      fontSize: 'var(--type-body-sm-size)',
                    }}
                  >
                    {buildSummaryData.reviewCount} review
                    {buildSummaryData.reviewCount === 1 ? '' : 's'}
                    {buildSummaryData.averageRating !== null
                      ? ` · average rating ${buildSummaryData.averageRating.toFixed(1)} / 5`
                      : ''}
                  </p>
                ) : null}
              </div>
            )}
          </Panel>

          {/* ── Tester participation ──────────────────────────────────────
              Project-scoped on purpose: the crowd is assembled across the
              project, and where it is based is not a per-build fact. This is
              the only thing the project report is fetched for, so nothing
              here repeats a number from the panels above. */}
          <Panel
            title="Tester participation"
            description="The crowd across every build on this project."
          >
            {!projectReport ? (
              <Muted>Participation could not be loaded. Refresh in a moment.</Muted>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
                <DescriptionList
                  items={[
                    { label: 'Testers on the project', value: String(projectReport.testerCount) },
                    { label: 'Bugs across all builds', value: String(projectReport.bugs.total) },
                    { label: 'Builds', value: String(project.builds.length) },
                  ]}
                />
                {Object.keys(projectReport.testersByCountry).length > 0 ? (
                  <BarChart
                    title="Testers by country"
                    segments={Object.entries(projectReport.testersByCountry).map(
                      ([label, value]) => ({ label, value, tone: 'info' as const }),
                    )}
                  />
                ) : (
                  <Muted>No testers have been assigned yet.</Muted>
                )}
              </div>
            )}
          </Panel>

          {capabilities.canUpdate ? (
            <Modal open={briefModalOpen} closedHref={closedHref} title="Edit the brief">
              <TrackedForm action={updateProjectBrief} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <Field label="Title" htmlFor="title" required>
                  <Input
                    id="title"
                    name="title"
                    required
                    minLength={3}
                    maxLength={200}
                    defaultValue={project.title}
                  />
                </Field>
                <Field label="Summary" htmlFor="summary" hint="One or two sentences on the scope.">
                  <Textarea
                    id="summary"
                    name="summary"
                    rows={3}
                    maxLength={2000}
                    defaultValue={project.summary ?? ''}
                  />
                </Field>
                <Field
                  label="Testing instructions"
                  htmlFor="instructions"
                  hint="What a tester needs to follow. Only visible to accepted testers."
                >
                  <Textarea
                    id="instructions"
                    name="instructions"
                    rows={10}
                    maxLength={20000}
                    defaultValue={project.instructions ?? ''}
                  />
                </Field>
                <div style={fieldGridStyle}>
                  <Field
                    label="Platform targets"
                    htmlFor="platformTargets"
                    hint="Comma separated, for example: Android, iOS, Web."
                  >
                    <Input
                      id="platformTargets"
                      name="platformTargets"
                      defaultValue={project.platformTargets.join(', ')}
                    />
                  </Field>
                  <Field
                    label="Target countries"
                    htmlFor="targetCountries"
                    hint="Two-letter ISO codes, comma separated: IN, GB, US."
                  >
                    <Input
                      id="targetCountries"
                      name="targetCountries"
                      defaultValue={project.targetCountries.join(', ')}
                    />
                  </Field>
                  <Field
                    label="Target languages"
                    htmlFor="targetLanguages"
                    hint="Two-letter ISO codes, comma separated: en, hi, ta."
                  >
                    <Input
                      id="targetLanguages"
                      name="targetLanguages"
                      defaultValue={project.targetLanguages.join(', ')}
                    />
                  </Field>
                  <Field label="Start date" htmlFor="startDate">
                    <Input
                      id="startDate"
                      name="startDate"
                      type="date"
                      defaultValue={toDateInput(project.startDate)}
                    />
                  </Field>
                  <Field
                    label="End date"
                    htmlFor="endDate"
                    hint="Must not fall before the start date."
                  >
                    <Input
                      id="endDate"
                      name="endDate"
                      type="date"
                      defaultValue={toDateInput(project.endDate)}
                    />
                  </Field>
                  <Field
                    label="Maximum testers"
                    htmlFor="maxTesters"
                    hint="Leave blank for no cap."
                  >
                    <Input
                      id="maxTesters"
                      name="maxTesters"
                      type="number"
                      min={1}
                      max={10000}
                      defaultValue={project.maxTesters ?? ''}
                    />
                  </Field>
                </div>
                <Checkbox
                  id="testersCanSeeOtherBugs"
                  name="testersCanSeeOtherBugs"
                  defaultChecked={project.testersCanSeeOtherBugs}
                  label="Testers can see bugs raised by others"
                  description="Off by default. When on, any tester with an accepted assignment on this project can read every bug logged against it, not just their own reports."
                />
                <div>
                  <SubmitButton variant="primary" pendingLabel="Saving…">
                    Save the brief
                  </SubmitButton>
                </div>
              </TrackedForm>
            </Modal>
          ) : null}
        </>
      ) : null}

      {section === 'build' ? (
        <>
          <Panel
            title={`Build details — ${activeBuild?.name ?? 'this build'}`}
            description="Everything specific to this test cycle. Switch builds above to see another cycle's own details."
            actions={
              capabilities.canUpdate ? (
                <Button
                  href={`${detailPath}?section=build&buildId=${activeBuildId}&edit=build-details`}
                  variant="primary"
                  size="sm"
                >
                  Edit
                </Button>
              ) : undefined
            }
          >
            {!buildDetail ? (
              <Muted>Build details could not be loaded. Refresh in a moment.</Muted>
            ) : (
              <DescriptionList
                items={[
                  { label: 'Status', value: <StatusBadge status={buildDetail.status} /> },
                  { label: 'Test type', value: buildDetail.testType ?? '—' },
                  {
                    label: 'Window',
                    value: `${formatDate(buildDetail.startDate)} to ${formatDate(buildDetail.endDate)}`,
                  },
                  {
                    label: 'Maximum testers',
                    value: buildDetail.maxTesters ? String(buildDetail.maxTesters) : 'No cap',
                  },
                  {
                    label: 'Testers can see others’ bugs',
                    value:
                      buildDetail.testersCanSeeOtherBugs === null
                        ? 'Inherits from the project'
                        : buildDetail.testersCanSeeOtherBugs
                          ? 'Yes'
                          : 'No',
                  },
                  {
                    label: 'Application / website URL',
                    value: buildDetail.appUrl ? (
                      <a
                        href={buildDetail.appUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: 'var(--text-brand)',
                          textDecoration: 'underline',
                          textUnderlineOffset: 3,
                        }}
                      >
                        {buildDetail.appUrl}
                      </a>
                    ) : (
                      '—'
                    ),
                  },
                  {
                    label: 'Test document',
                    value: buildDetail.testDocument ? buildDetail.testDocument.originalName : '—',
                  },
                  {
                    label: 'Target countries',
                    value: <TokenList values={buildDetail.targetCountries} />,
                  },
                  {
                    label: 'Target languages',
                    value: <TokenList values={buildDetail.targetLanguages} uppercase={false} />,
                  },
                  {
                    label: 'Target devices',
                    value: <TokenList values={buildDetail.targetDevices} uppercase={false} />,
                  },
                  {
                    label: 'Target browsers',
                    value: <TokenList values={buildDetail.targetBrowsers} uppercase={false} />,
                  },
                  {
                    label: 'Target operating systems',
                    value: (
                      <TokenList values={buildDetail.targetOperatingSystems} uppercase={false} />
                    ),
                  },
                  {
                    label: 'Features',
                    wide: true,
                    value: buildDetail.description ? <Prose>{buildDetail.description}</Prose> : '',
                  },
                  {
                    label: 'Testing instructions',
                    wide: true,
                    value: buildDetail.instructions ? (
                      <Prose>{buildDetail.instructions}</Prose>
                    ) : (
                      ''
                    ),
                  },
                  {
                    label: 'Special requirements',
                    wide: true,
                    value: buildDetail.specialRequirements ? (
                      <Prose>{buildDetail.specialRequirements}</Prose>
                    ) : (
                      ''
                    ),
                  },
                  {
                    label: 'Release notes',
                    wide: true,
                    value: buildDetail.releaseNotes ? (
                      <Prose>{buildDetail.releaseNotes}</Prose>
                    ) : (
                      ''
                    ),
                  },
                ]}
              />
            )}
          </Panel>

          {capabilities.canUpdate ? (
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <form action={copyBuild}>
                <input type="hidden" name="id" value={project.id} />
                <input type="hidden" name="buildId" value={activeBuildId} />
                <SubmitButton variant="secondary" iconLeft="repeat" pendingLabel="Copying…">
                  Copy this build
                </SubmitButton>
              </form>
            </div>
          ) : null}
        </>
      ) : null}

      {capabilities.canUpdate && buildDetail ? (
        <Modal open={buildDetailsModalOpen} closedHref={closedHref} title="Edit build details">
          <TrackedForm action={updateBuild} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="buildId" value={activeBuildId} />
            <input type="hidden" name="section" value={section} />
            <Field label="Name" htmlFor="build-name">
              <Input id="build-name" name="name" maxLength={120} defaultValue={buildDetail.name} />
            </Field>
            <div style={fieldGridStyle}>
              <Field label="Status" htmlFor="build-status">
                <Select
                  id="build-status"
                  name="status"
                  defaultValue={buildDetail.status}
                  options={BUILD_STATUSES.map((v) => ({ value: v, label: titleCase(v) }))}
                />
              </Field>
              <Field
                label="Test type"
                htmlFor="build-testType"
                hint="Exploratory, regression, smoke, load..."
              >
                <Input
                  id="build-testType"
                  name="testType"
                  maxLength={120}
                  defaultValue={buildDetail.testType ?? ''}
                />
              </Field>
              <Field label="Start date" htmlFor="build-startDate">
                <Input
                  id="build-startDate"
                  name="startDate"
                  type="date"
                  defaultValue={toDateInput(buildDetail.startDate)}
                />
              </Field>
              <Field label="End date" htmlFor="build-endDate">
                <Input
                  id="build-endDate"
                  name="endDate"
                  type="date"
                  defaultValue={toDateInput(buildDetail.endDate)}
                />
              </Field>
              <Field
                label="Maximum testers"
                htmlFor="build-maxTesters"
                hint="Leave blank for no cap."
              >
                <Input
                  id="build-maxTesters"
                  name="maxTesters"
                  type="number"
                  min={1}
                  max={10000}
                  defaultValue={buildDetail.maxTesters ?? ''}
                />
              </Field>
              <Field label="Application / website URL" htmlFor="build-appUrl">
                <Input
                  id="build-appUrl"
                  name="appUrl"
                  type="url"
                  maxLength={2000}
                  defaultValue={buildDetail.appUrl ?? ''}
                />
              </Field>
            </div>
            <div style={fieldGridStyle}>
              <Field
                label="Target countries"
                htmlFor="build-targetCountries"
                hint="Comma separated: IN, GB, US."
              >
                <Input
                  id="build-targetCountries"
                  name="targetCountries"
                  defaultValue={buildDetail.targetCountries.join(', ')}
                />
              </Field>
              <Field
                label="Target languages"
                htmlFor="build-targetLanguages"
                hint="Comma separated: en, hi, ta."
              >
                <Input
                  id="build-targetLanguages"
                  name="targetLanguages"
                  defaultValue={buildDetail.targetLanguages.join(', ')}
                />
              </Field>
              <Field label="Target devices" htmlFor="build-targetDevices" hint="Comma separated.">
                <Input
                  id="build-targetDevices"
                  name="targetDevices"
                  defaultValue={buildDetail.targetDevices.join(', ')}
                />
              </Field>
              <Field label="Target browsers" htmlFor="build-targetBrowsers" hint="Comma separated.">
                <Input
                  id="build-targetBrowsers"
                  name="targetBrowsers"
                  defaultValue={buildDetail.targetBrowsers.join(', ')}
                />
              </Field>
              <Field
                label="Target operating systems"
                htmlFor="build-targetOperatingSystems"
                hint="Comma separated."
              >
                <Input
                  id="build-targetOperatingSystems"
                  name="targetOperatingSystems"
                  defaultValue={buildDetail.targetOperatingSystems.join(', ')}
                />
              </Field>
            </div>
            <Field label="Features / scope" htmlFor="build-description">
              <Textarea
                id="build-description"
                name="description"
                rows={3}
                defaultValue={buildDetail.description ?? ''}
              />
            </Field>
            <Field label="Testing instructions" htmlFor="build-instructions">
              <Textarea
                id="build-instructions"
                name="instructions"
                rows={6}
                defaultValue={buildDetail.instructions ?? ''}
              />
            </Field>
            <Field label="Special requirements" htmlFor="build-specialRequirements">
              <Textarea
                id="build-specialRequirements"
                name="specialRequirements"
                rows={3}
                defaultValue={buildDetail.specialRequirements ?? ''}
              />
            </Field>
            <Field label="Release notes" htmlFor="build-releaseNotes">
              <Textarea
                id="build-releaseNotes"
                name="releaseNotes"
                rows={3}
                defaultValue={buildDetail.releaseNotes ?? ''}
              />
            </Field>
            <Checkbox
              name="testersCanSeeOtherBugs"
              defaultChecked={buildDetail.testersCanSeeOtherBugs ?? false}
              label="Testers can see bugs raised by others (this build)"
              description="Overrides the project's own setting for this build only."
            />
            <div>
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Save build details
              </SubmitButton>
            </div>
          </TrackedForm>
        </Modal>
      ) : null}

      {section === 'materials' ? (
        <>
          <Panel
            title="Materials"
            description="Builds, credentials and reference documents an accepted tester can open."
          >
            {!capabilities.canReadBrief ? (
              <Muted>The brief and its materials are not visible to you on this project.</Muted>
            ) : project.materials.length === 0 ? (
              <Muted>No material is attached yet.</Muted>
            ) : (
              <ul style={listResetStyle}>
                {project.materials.map((material) => (
                  <li key={material.id} style={rowStyle}>
                    <div
                      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
                    >
                      <span style={{ fontSize: 'var(--type-body-sm-size)' }}>{material.title}</span>
                      {material.description ? <Caption>{material.description}</Caption> : null}
                      <MaterialTarget material={material} />
                      <Caption>Added {formatDate(material.createdAt)}</Caption>
                    </div>
                    {capabilities.canManageMaterials ? (
                      <form action={removeMaterial}>
                        <input type="hidden" name="id" value={project.id} />
                        <input type="hidden" name="materialId" value={material.id} />
                        <ConfirmSubmit iconLeft="x" question={`Remove ${material.title}?`}>
                          Remove
                        </ConfirmSubmit>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {capabilities.canManageMaterials ? (
            <Panel
              title="Attach a material"
              description="Give it a title and either a link or the id of a file already uploaded."
            >
              <form action={addMaterial} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <input type="hidden" name="buildId" value={activeBuildId} />
                <div style={fieldGridStyle}>
                  <Field label="Title" htmlFor="material-title" required>
                    <Input
                      id="material-title"
                      name="title"
                      required
                      maxLength={200}
                      placeholder="Android build 4.2.1"
                    />
                  </Field>
                  <Field label="Link" htmlFor="material-url" hint="A full https:// URL.">
                    <Input
                      id="material-url"
                      name="url"
                      type="url"
                      maxLength={2000}
                      placeholder="https://builds.example.com/4.2.1.apk"
                    />
                  </Field>
                  <Field
                    label="Uploaded file id"
                    htmlFor="material-file"
                    hint="Use instead of a link when the file came through the uploads endpoint."
                  >
                    <Input id="material-file" name="fileId" placeholder="cl…" />
                  </Field>
                </div>
                <Field
                  label="Description"
                  htmlFor="material-description"
                  hint="What it is and what to do with it."
                >
                  <Textarea
                    id="material-description"
                    name="description"
                    rows={3}
                    maxLength={2000}
                  />
                </Field>
                <div>
                  <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Attaching…">
                    Attach material
                  </SubmitButton>
                </div>
              </form>
            </Panel>
          ) : null}
        </>
      ) : null}

      {section === 'features' ? (
        <Panel
          title="Features"
          description="The tags a bug can be filed against. Delete one and any bug already carrying it just loses the tag — the report stays."
        >
          {!features ? (
            <Muted>Features could not be read.</Muted>
          ) : features.length === 0 ? (
            <Muted>No features listed yet.</Muted>
          ) : (
            <ul style={listResetStyle}>
              {features.map((feature) => (
                <li key={feature.id} style={rowStyle}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <span style={{ fontSize: 'var(--type-body-sm-size)' }}>{feature.name}</span>
                    <Caption>
                      {feature._count.bugs} bug{feature._count.bugs === 1 ? '' : 's'}
                    </Caption>
                  </div>
                  {capabilities.canManageMaterials ? (
                    <form action={removeFeature}>
                      <input type="hidden" name="id" value={project.id} />
                      <input type="hidden" name="featureId" value={feature.id} />
                      <ConfirmSubmit
                        iconLeft="x"
                        question={`Remove ${feature.name}?${
                          feature._count.bugs > 0
                            ? ` ${feature._count.bugs} bug${feature._count.bugs === 1 ? '' : 's'} will be left without a feature.`
                            : ''
                        }`}
                      >
                        Remove
                      </ConfirmSubmit>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {capabilities.canManageMaterials ? (
            <form
              action={addFeature}
              style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-5)' }}
            >
              <input type="hidden" name="id" value={project.id} />
              <input type="hidden" name="buildId" value={activeBuildId} />
              <Input name="name" required maxLength={120} placeholder="Checkout" />
              <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Adding…">
                Add feature
              </SubmitButton>
            </form>
          ) : null}
        </Panel>
      ) : null}

      {section === 'bugs' ? (
        <Panel
          title="Bugs"
          description={
            !bugs
              ? "This build's reports."
              : bugs.length >= BUG_PREVIEW_SIZE
                ? `The ${BUG_PREVIEW_SIZE} most recent reports on ${activeBuild?.name ?? 'this build'}.`
                : `${bugs.length} report${bugs.length === 1 ? '' : 's'} on ${activeBuild?.name ?? 'this build'}.`
          }
          flush
        >
          {!bugs ? (
            <div style={{ padding: 'var(--space-6)' }}>
              <Muted>The bugs service is unreachable. Refresh in a moment.</Muted>
            </div>
          ) : (
            <Table
              ariaLabel="Bugs on this project"
              columns={bugColumns}
              rows={bugs}
              rowKey={(row) => row.id}
              rowHref={(row) => `/app/customer/bugs/${row.id}`}
              style={bareTableStyle}
              emptyState={
                <div style={{ padding: 'var(--space-6)' }}>
                  <Muted>No defect has been logged against this project yet.</Muted>
                </div>
              }
            />
          )}
        </Panel>
      ) : null}

      {/* ── Testers on this build ─────────────────────────────────────────
          Read-only by design. `project.assign_testers` does not include
          `project:customer` — the API reports `canAssignTesters: false` — so
          the crowd is allocated by the platform, not the client. Rendering
          assignment controls here would be a button that 403s.

          Tester email addresses are not shown because the API no longer sends
          them to a customer at all: a client needs to know who is on the
          build, not how to contact them off-platform. */}
      {section === 'testers' ? (
        <Panel
          title="Testers"
          description={`Who is working on ${activeBuild?.name ?? 'this build'}.`}
          flush
        >
          {project.assignments.length === 0 ? (
            <div style={{ padding: 'var(--space-6)' }}>
              <EmptyState
                icon="users"
                title="No testers on this build yet"
                description="Once the platform assigns testers to this build they appear here with their standing."
              />
            </div>
          ) : (
            /*
             * Rows link to the tester's profile, but only when there is a
             * profile to link to. `testerProfile` is nullable, and the
             * profile route resolves a testerProfile id — linking with the
             * user id instead would 404 on every row.
             */
            <Table
              columns={testerColumns}
              rows={[...project.assignments]}
              rowKey={(row) => row.tester.id}
              rowHref={(row) =>
                row.tester.testerProfile
                  ? `/app/customer/crowdtesters/${row.tester.testerProfile.id}`
                  : ''
              }
            />
          )}
        </Panel>
      ) : null}

      {/* ── Announcements ────────────────────────────────────────────────
          Read-only: posting one needs the `announcement.write` permission,
          which is admin-side. Notices to the crowd go out through the
          platform, so there is no compose form here — see the note in the
          page docblock. */}
      {section === 'announcements' ? (
        <>
          {openAnnouncement ? (
            <>
              <MarkReadOnView
                notificationId={reads.notificationIdFor.get(openAnnouncement.id) ?? null}
              />
              <Panel
                title={openAnnouncement.title}
                description={[
                  openAnnouncement.author ? personName(openAnnouncement.author) : 'Crowd4Test',
                  openAnnouncement.buildId
                    ? (openAnnouncement.build?.name ?? 'This build')
                    : openAnnouncement.projectId
                      ? 'This project'
                      : 'Platform-wide',
                  formatDateTime(openAnnouncement.publishedAt),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                actions={
                  <Button
                    href={`${detailPath}?section=announcements&buildId=${activeBuildId}`}
                    variant="secondary"
                    size="sm"
                    iconLeft="arrow-left"
                  >
                    Back
                  </Button>
                }
              >
                <Prose>{openAnnouncement.body}</Prose>
              </Panel>
            </>
          ) : null}

          <Panel
            title="Announcements"
            description="Notices posted to the testers on this project."
            flush={announcementItems.length > 0}
          >
            {announcements === null ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                Announcements could not be loaded. Refresh in a moment.
              </p>
            ) : announcementItems.length === 0 ? (
              <EmptyState
                icon="message-square"
                title="Nothing posted yet"
                description="Announcements for this project and build will appear here. Ask your Crowd4Test contact to post one."
              />
            ) : (
              <InboxList items={announcementItems} />
            )}
          </Panel>
        </>
      ) : null}

      {/* ── Build settings: the client's own bug form (§36-38) ─────────── */}
      {section === 'settings' ? (
        <>
          <Panel
            title="Extra bug questions"
            description={`Ask testers on ${activeBuild?.name ?? 'this build'} for more than the standard bug form collects.`}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <DescriptionList
                items={[
                  {
                    label: 'Currently',
                    value: buildDetail?.bugCustomizationEnabled ? (
                      <Badge tone="success" uppercase={false}>
                        On
                      </Badge>
                    ) : (
                      <Badge tone="neutral" uppercase={false}>
                        Off
                      </Badge>
                    ),
                  },
                  {
                    label: 'Fields configured',
                    value: String(customFields?.length ?? 0),
                  },
                ]}
              />

              <p
                style={{
                  margin: 0,
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                  maxWidth: '70ch',
                }}
              >
                Turning this off hides the extra questions from the tester form without deleting
                them, or the answers already given.
              </p>

              {capabilities.canManageMaterials ? (
                <form
                  action={setBugCustomization}
                  style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}
                >
                  <input type="hidden" name="id" value={project.id} />
                  <input type="hidden" name="buildId" value={activeBuildId} />
                  <input
                    type="hidden"
                    name="enabled"
                    value={buildDetail?.bugCustomizationEnabled ? 'no' : 'yes'}
                  />
                  <SubmitButton
                    variant={buildDetail?.bugCustomizationEnabled ? 'secondary' : 'primary'}
                    pendingLabel="Saving…"
                  >
                    {buildDetail?.bugCustomizationEnabled
                      ? 'Turn the extra questions off'
                      : 'Turn the extra questions on'}
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          </Panel>

          <Panel title="Fields" description="Shown on the bug form in this order." flush>
            {customFields === null ? (
              <div style={{ padding: 'var(--space-6)' }}>
                <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                  These could not be loaded. Refresh in a moment.
                </p>
              </div>
            ) : customFields.length === 0 ? (
              <div style={{ padding: 'var(--space-6)' }}>
                <EmptyState
                  icon="layout-grid"
                  title="No extra fields yet"
                  description="Add one below and it appears on the bug form for this build."
                />
              </div>
            ) : (
              <Table
                columns={customFieldColumns}
                rows={[...customFields]}
                rowKey={(row) => row.id}
              />
            )}
          </Panel>

          {capabilities.canManageMaterials ? (
            <Panel title="Add a field" description="It appears on the bug form straight away.">
              <CustomFieldForm
                action={addBugCustomField}
                projectId={project.id}
                buildId={activeBuildId}
                section="settings"
              />
            </Panel>
          ) : null}
        </>
      ) : null}

      {capabilities.canUpdate ? (
        <Modal open={newBuildModalOpen} closedHref={closedHref} title="New build">
          <TrackedForm action={createBuild} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="section" value={section} />
            <Field
              label="Name"
              htmlFor="new-build-name"
              hint="For example: Build 1.2, or Release candidate 3."
            >
              <Input id="new-build-name" name="name" required maxLength={120} autoFocus />
            </Field>
            <div style={fieldGridStyle}>
              <Field label="Status" htmlFor="new-build-status">
                <Select
                  id="new-build-status"
                  name="status"
                  defaultValue="NEW"
                  options={BUILD_STATUSES.map((v) => ({ value: v, label: titleCase(v) }))}
                />
              </Field>
              <Field
                label="Test type"
                htmlFor="new-build-testType"
                hint="Exploratory, regression, smoke, load..."
              >
                <Input
                  id="new-build-testType"
                  name="testType"
                  maxLength={120}
                  defaultValue={defaultBuildDetail?.testType ?? ''}
                />
              </Field>
              <Field label="Start date" htmlFor="new-build-startDate">
                <Input id="new-build-startDate" name="startDate" type="date" />
              </Field>
              <Field label="End date" htmlFor="new-build-endDate">
                <Input id="new-build-endDate" name="endDate" type="date" />
              </Field>
              <Field
                label="Maximum testers"
                htmlFor="new-build-maxTesters"
                hint="Leave blank for no cap."
              >
                <Input
                  id="new-build-maxTesters"
                  name="maxTesters"
                  type="number"
                  min={1}
                  max={10000}
                  defaultValue={defaultBuildDetail?.maxTesters ?? ''}
                />
              </Field>
              <Field label="Application / website URL" htmlFor="new-build-appUrl">
                <Input
                  id="new-build-appUrl"
                  name="appUrl"
                  type="url"
                  maxLength={2000}
                  defaultValue={defaultBuildDetail?.appUrl ?? ''}
                />
              </Field>
            </div>
            <div style={fieldGridStyle}>
              <Field
                label="Target countries"
                htmlFor="new-build-targetCountries"
                hint="Comma separated: IN, GB, US."
              >
                <Input
                  id="new-build-targetCountries"
                  name="targetCountries"
                  defaultValue={defaultBuildDetail?.targetCountries.join(', ') ?? ''}
                />
              </Field>
              <Field
                label="Target languages"
                htmlFor="new-build-targetLanguages"
                hint="Comma separated: en, hi, ta."
              >
                <Input
                  id="new-build-targetLanguages"
                  name="targetLanguages"
                  defaultValue={defaultBuildDetail?.targetLanguages.join(', ') ?? ''}
                />
              </Field>
              <Field
                label="Target devices"
                htmlFor="new-build-targetDevices"
                hint="Comma separated."
              >
                <Input
                  id="new-build-targetDevices"
                  name="targetDevices"
                  defaultValue={defaultBuildDetail?.targetDevices.join(', ') ?? ''}
                />
              </Field>
              <Field
                label="Target browsers"
                htmlFor="new-build-targetBrowsers"
                hint="Comma separated."
              >
                <Input
                  id="new-build-targetBrowsers"
                  name="targetBrowsers"
                  defaultValue={defaultBuildDetail?.targetBrowsers.join(', ') ?? ''}
                />
              </Field>
              <Field
                label="Target operating systems"
                htmlFor="new-build-targetOperatingSystems"
                hint="Comma separated."
              >
                <Input
                  id="new-build-targetOperatingSystems"
                  name="targetOperatingSystems"
                  defaultValue={defaultBuildDetail?.targetOperatingSystems.join(', ') ?? ''}
                />
              </Field>
            </div>
            <Field label="Features / scope" htmlFor="new-build-description">
              <Textarea
                id="new-build-description"
                name="description"
                rows={3}
                defaultValue={defaultBuildDetail?.description ?? ''}
              />
            </Field>
            <Field label="Testing instructions" htmlFor="new-build-instructions">
              <Textarea
                id="new-build-instructions"
                name="instructions"
                rows={6}
                defaultValue={defaultBuildDetail?.instructions ?? ''}
              />
            </Field>
            <Field label="Special requirements" htmlFor="new-build-specialRequirements">
              <Textarea
                id="new-build-specialRequirements"
                name="specialRequirements"
                rows={3}
                defaultValue={defaultBuildDetail?.specialRequirements ?? ''}
              />
            </Field>
            <Field label="Release notes" htmlFor="new-build-releaseNotes">
              <Textarea
                id="new-build-releaseNotes"
                name="releaseNotes"
                rows={3}
                defaultValue={defaultBuildDetail?.releaseNotes ?? ''}
              />
            </Field>
            <Checkbox
              name="testersCanSeeOtherBugs"
              defaultChecked={defaultBuildDetail?.testersCanSeeOtherBugs ?? false}
              label="Testers can see bugs raised by others (this build)"
              description="Overrides the project's own setting for this build only."
            />
            <div>
              <SubmitButton variant="primary" pendingLabel="Creating…">
                Create build
              </SubmitButton>
            </div>
          </TrackedForm>
        </Modal>
      ) : null}

      {/* ── Rate a tester on this project ────────────────────────────────
          Opened by ?rate=<testerUserId> from the Testers table. `returnTo`
          brings the person back here rather than to the tester's profile,
          which is where the same action's other caller starts from. */}
      {ratingTarget ? (
        <Modal
          open
          closedHref={`${detailPath}?section=testers&buildId=${activeBuildId}`}
          title={`Rate ${personName(ratingTarget.tester)}`}
        >
          <form action={rateTesterAction} style={stackStyle}>
            <input type="hidden" name="subjectUserId" value={ratingTarget.tester.id} />
            <input
              type="hidden"
              name="testerProfileId"
              value={ratingTarget.tester.testerProfile?.id ?? ''}
            />
            <input type="hidden" name="projectId" value={project.id} />
            <input
              type="hidden"
              name="returnTo"
              value={`${detailPath}?section=testers&buildId=${activeBuildId}`}
            />

            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              For their work on {project.reference} · {project.title}.
            </p>

            <Field label="Score" htmlFor="rating-score" required hint="1 is poor, 5 is excellent.">
              <Select
                id="rating-score"
                name="score"
                required
                defaultValue="5"
                options={[5, 4, 3, 2, 1].map((n) => ({
                  value: String(n),
                  label: `${n} — ${RATING_SCORE_LABEL[n]}`,
                }))}
              />
            </Field>
            <Field
              label="Comment"
              htmlFor="rating-comment"
              hint="Optional. Shared with the tester."
            >
              <Textarea id="rating-comment" name="comment" rows={4} maxLength={2000} />
            </Field>
            <div>
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Submit rating
              </SubmitButton>
            </div>
          </form>
        </Modal>
      ) : null}

      {capabilities.canUpdate ? (
        <Modal open={edit === 'rename-build'} closedHref={closedHref} title="Rename build">
          <form action={renameBuild} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="buildId" value={activeBuildId} />
            <input type="hidden" name="section" value={section} />
            <Field label="Name" htmlFor="rename-build-name">
              <Input
                id="rename-build-name"
                name="name"
                required
                maxLength={120}
                // The rejected name, when one comes back — retyping it only
                // to be told again why it was refused helps nobody.
                defaultValue={resolvedSearchParams.name ?? activeBuild?.name}
                autoFocus
              />
            </Field>
            <div>
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Save name
              </SubmitButton>
            </div>
          </form>
        </Modal>
      ) : null}
    </DetailShell>
  )
}

const stackStyle = { display: 'flex', flexDirection: 'column' as const, gap: 'var(--space-5)' }
const fieldGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 'var(--space-5)',
}
const listResetStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column' as const,
}
const rowStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--space-5)',
  paddingBlock: 'var(--space-4)',
  borderBottom: '1px solid var(--border-subtle)',
}
const bareTableStyle = { border: 'none', borderRadius: 0, background: 'transparent' }

function Muted({ children }: { children: ReactNode }) {
  return (
    <p
      className="c4t-body-sm"
      style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}
    >
      {children}
    </p>
  )
}
function Caption({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 'var(--type-caption-size)', color: 'var(--text-muted)' }}>
      {children}
    </span>
  )
}
function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: 'var(--font-mono)' }}>{children}</span>
}
function Prose({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'block', whiteSpace: 'pre-wrap', maxWidth: '75ch' }}>{children}</span>
  )
}
function TokenList({ values, uppercase = true }: { values: string[]; uppercase?: boolean }) {
  if (values.length === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {values.map((value) => (
        <Badge key={value} tone="neutral" uppercase={uppercase}>
          {value}
        </Badge>
      ))}
    </span>
  )
}
function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      role="img"
      aria-label={`${clamped}% complete`}
    >
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 'var(--space-3)',
          borderRadius: 'var(--radius-full)',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${clamped}%`,
            background: 'var(--accent-base)',
          }}
        />
      </span>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
        }}
      >
        {clamped}%
      </span>
    </span>
  )
}
function MaterialTarget({ material }: { material: ProjectMaterial }) {
  if (material.file) {
    return (
      <Caption>
        {material.file.originalName} · {material.file.mimeType} ·{' '}
        {formatBytes(material.file.sizeBytes)}
      </Caption>
    )
  }
  if (material.url) {
    return (
      <a
        href={material.url}
        rel="noreferrer noopener"
        target="_blank"
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
        <Icon name="share-2" size={16} />
        {material.url}
      </a>
    )
  }
  return <Caption>No link or file recorded.</Caption>
}
function toDateInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

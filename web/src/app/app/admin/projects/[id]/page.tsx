import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Modal } from '@/components/admin/Modal'
import { Panel } from '@/components/admin/Panel'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { DescriptionList, type DescriptionItem } from '@/components/admin/DescriptionList'
import { StatusBadge, SeverityBadge, RoleBadge, statusTone, severityTone, bugTypeTone } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { loadList } from '@/lib/admin/list'
import { requireRole, hasPermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { formatDate, personName, titleCase } from '@/lib/admin/format'
import { BuildSwitcher } from '@/components/admin/BuildSwitcher'
import {
  ASSIGNMENT_STATUSES,
  BUILD_STATUSES,
  PROJECT_PRIORITIES,
  allowedTransitions,
  deviceFitsTargets,
  isProjectPriority,
  type BuildDetail,
  type BuildSummary,
  type ProjectAssignmentRow,
  type ProjectBugRow,
  type ProjectDetail,
  type ProjectMaterial,
  type ProjectReportSummary,
  type TestCaseRow,
  type VerifiedTesterRow,
} from './constants'
import { BarChart } from '@/components/admin/charts/BarChart'
import { DonutChart } from '@/components/admin/charts/DonutChart'
import {
  addFeature,
  addMaterial,
  archiveProject,
  changeProjectStatus,
  createBuild,
  createTestCase,
  assignTestCase,
  inviteTesters,
  removeFeature,
  removeMaterial,
  renameBuild,
  updateBuild,
  copyBuild,
  updateAssignment,
  updateProjectBrief,
  updateProjectDelivery,
} from './actions'

/**
 * `/app/admin/projects/[id]` — the project workbench (§2.2 Project Management).
 *
 * Every panel is one form and one API call, so a failed save only ever loses the
 * fields in that panel. The split between the wide column and the aside is by
 * volume, not importance: the status control is the most consequential thing on
 * the page and still sits in the aside, because it is one select.
 *
 * There is no client JavaScript here. Each form is a plain
 * `<form action={serverAction}>` with a hidden id, which means the page works
 * before hydration and needs no error-boundary-shaped client state.
 */

/** Verified testers offered per invite. Well under the API's 200-id ceiling. */
const TESTER_POOL_SIZE = 40
/** Bugs shown inline. The full set lives on the bugs list. */
const BUG_PREVIEW_SIZE = 10

/**
 * Sub-navigation for the record. The page carried fifteen panels in one
 * column — everything below "Edit the brief" was several screens of scrolling
 * away, and the page rendered all of it on every visit regardless of what the
 * reader came for.
 *
 * The aside (status, progress, at-a-glance, managers) deliberately stays
 * outside these sections: it is the record's context, and it is as relevant
 * while reading bugs as while editing the brief.
 */
const SECTIONS = [
  { value: 'overview', label: 'Overview', icon: 'file-text' },
  { value: 'build', label: 'Build details', icon: 'clock' },
  { value: 'testers', label: 'Testers', icon: 'users' },
  { value: 'materials', label: 'Materials', icon: 'book-open' },
  { value: 'features', label: 'Features', icon: 'layout-grid' },
  { value: 'testing', label: 'Test reports', icon: 'test-tube-diagonal' },
  { value: 'bugs', label: 'Bugs', icon: 'clipboard-check' },
  { value: 'settings', label: 'Settings', icon: 'shield-alert' },
] as const

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ section?: string; edit?: string; buildId?: string }>
}) {
  const user = await requireRole(['ADMIN', 'SUB_ADMIN'])
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const section = resolveSection(SECTIONS, resolvedSearchParams.section)
  const edit = resolvedSearchParams.edit
  const buildId = resolvedSearchParams.buildId

  let project: ProjectDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    // `serverFetch` unwraps the `{ data }` envelope — this IS the project.
    // Omitting `buildId` (the common case) resolves server-side to the
    // project's default build — see `resolveBuildId` in projects.service.ts.
    project = await serverFetch<ProjectDetail>(`projects/${id}`, { query: { buildId } })
  } catch (err) {
    // The API returns 404 rather than 403 when a project is out of scope, so a
    // genuine 404 and "not yours" are the same page by design.
    if (err instanceof ApiError && err.status === 404) notFound()
    if (err instanceof ApiError && err.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError !== null || project === null) {
    return (
      <DetailShell
        crumbs={[
          { label: 'Projects', href: '/app/admin/projects' },
          { label: loadError === 'forbidden' ? 'Restricted' : 'Unavailable' },
        ]}
        eyebrow="Delivery"
        title={loadError === 'forbidden' ? 'Restricted' : 'Unavailable'}
      >
        {loadError === 'forbidden' ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this project"
            description="Ask an administrator to grant you the project.read permission."
            action={
              <Button variant="secondary" href="/app/admin/projects">
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
              <Button variant="secondary" href="/app/admin/projects">
                Back to projects
              </Button>
            }
          />
        )}
      </DetailShell>
    )
  }

  const canDelete = hasPermission(user, 'project.delete')
  const { capabilities } = project
  // The build every build-scoped tab below reads and writes against. The API
  // already resolved this (the requested `?buildId=`, or the project's
  // default build when none was given) — `project.materials`/`assignments`
  // arrived pre-filtered to it; `bugs`/`features` are separate fetches that
  // need to pass it along themselves.
  const activeBuildId = project.activeBuildId

  // Both lists are read in parallel with each other; the project read above had
  // to come first because a 404 there means there is no page to fill in.
  const [testerPool, bugs, features, buildDetail, buildSummaryData, testCases, projectReport] = await Promise.all([
    capabilities.canAssignTesters
      ? loadList<VerifiedTesterRow>('testers', {
          page: 1,
          limit: TESTER_POOL_SIZE,
          query: { status: 'VERIFIED', sort: 'ratingAverage', order: 'desc' },
        })
      : Promise.resolve({ error: 'forbidden' as const }),
    loadList<ProjectBugRow>('bugs', {
      page: 1,
      limit: BUG_PREVIEW_SIZE,
      query: { projectId: project.id, buildId: activeBuildId },
    }),
    serverFetchOrNull<readonly { id: string; name: string; createdAt: string; _count: { bugs: number } }[]>(
      `projects/${project.id}/features`,
      { query: { buildId: activeBuildId } },
    ),
    serverFetchOrNull<BuildDetail>(`projects/${project.id}/builds/${activeBuildId}`),
    serverFetchOrNull<BuildSummary>(`builds/${activeBuildId}/summary`),
    loadList<TestCaseRow>('test-cases', {
      page: 1,
      limit: 50,
      query: { buildId: activeBuildId },
    }),
    // Same by-project report the Reports module's "By project" section
    // renders — reused for the Overview tab's summary rather than a second
    // aggregation. Rolled up across every build, unlike `buildSummaryData`.
    serverFetchOrNull<ProjectReportSummary>(`reports/by-project/${project.id}`),
  ])

  const assignedTesterIds = new Set(project.assignments.map((row) => row.tester.id))
  // `assertAssignable` on the API rejects a tester who is not ACTIVE or has not
  // accepted the NDA, so those are filtered out here rather than offered and
  // then refused. Already-assigned testers are dropped for the same reason.
  const invitable =
    'items' in testerPool
      ? testerPool.items.filter(
          (tester) =>
            tester.user.status === 'ACTIVE' &&
            tester.ndaAcceptedAt !== null &&
            !assignedTesterIds.has(tester.user.id),
        )
      : []

  const transitions = allowedTransitions(project.status)
  const priority = isProjectPriority(project.priority) ? project.priority : 'NORMAL'

  const detailPath = `/app/admin/projects/${project.id}`
  const closedHref = (() => {
    const sp = new URLSearchParams()
    if (section !== SECTIONS[0].value) sp.set('section', section)
    if (buildId) sp.set('buildId', buildId)
    const qs = sp.toString()
    return qs ? `${detailPath}?${qs}` : detailPath
  })()
  const briefModalOpen = edit === 'brief'
  const newBuildModalOpen = edit === 'new-build'
  const renameBuildModalOpen = edit === 'rename-build'
  const buildDetailsModalOpen = edit === 'build-details'
  const activeBuild = project.builds.find((b) => b.id === activeBuildId)

  const overview: DescriptionItem[] = [
    { label: 'Reference', value: <Mono>{project.reference}</Mono> },
    {
      label: 'Organisation',
      value: (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <Link
            href={`/app/admin/organisations/${project.organisation.id}`}
            style={{
              color: 'var(--text-brand)',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            {project.organisation.name}
          </Link>
          <StatusBadge status={project.organisation.status} />
        </span>
      ),
    },
    { label: 'Raised by', value: personName(project.createdBy) },
    { label: 'Priority', value: titleCase(project.priority) },
    { label: 'Created', value: formatDate(project.createdAt) },
    { label: 'Last updated', value: formatDate(project.updatedAt) },
    { label: 'Submitted', value: formatDate(project.submittedAt) },
    { label: 'Approved', value: formatDate(project.approvedAt) },
    { label: 'Completed', value: formatDate(project.completedAt) },
    { label: 'Window', value: `${formatDate(project.startDate)} to ${formatDate(project.endDate)}` },
    { label: 'Platform targets', value: <TokenList values={project.platformTargets} /> },
    { label: 'Target countries', value: <TokenList values={project.targetCountries} /> },
    {
      label: 'Target languages',
      value: <TokenList values={project.targetLanguages} uppercase={false} />,
    },
    {
      label: 'Summary',
      wide: true,
      value: project.summary ? <Prose>{project.summary}</Prose> : '',
    },
    {
      label: 'Testing instructions',
      wide: true,
      value: project.instructions ? <Prose>{project.instructions}</Prose> : '',
    },
  ]

  const assignmentColumns: readonly TableColumn<ProjectAssignmentRow>[] = [
    {
      key: 'tester',
      header: 'Tester',
      render: (row) => personName(row.tester),
      renderSecondary: (row) => row.tester.email,
    },
    {
      key: 'status',
      header: 'Assignment',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'country',
      header: 'Country',
      render: (row) => row.tester.testerProfile?.countryCode ?? '—',
    },
    {
      key: 'rating',
      header: 'Rating',
      align: 'right',
      render: (row) => formatRating(row.tester.testerProfile?.ratingAverage),
    },
    { key: 'invited', header: 'Invited', align: 'right', render: (row) => formatDate(row.invitedAt) },
    {
      key: 'responded',
      header: 'Responded',
      align: 'right',
      render: (row) => formatDate(row.respondedAt),
    },
  ]

  const bugColumns: readonly TableColumn<ProjectBugRow>[] = [
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) => row.reference,
    },
    { key: 'severity', header: 'Severity', render: (row) => <SeverityBadge severity={row.severity} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'reporter', header: 'Reported by', render: (row) => personName(row.reportedBy) },
    { key: 'logged', header: 'Logged', align: 'right', render: (row) => formatDate(row.createdAt) },
  ]

  return (
    <DetailShell
      crumbs={[{ label: 'Projects', href: '/app/admin/projects' }, { label: project.reference }]}
      eyebrow="Delivery"
      title={project.title}
      badges={
        <>
          <StatusBadge status={project.status} />
          <Badge tone={priority === 'URGENT' || priority === 'HIGH' ? 'warning' : 'neutral'}>
            {priority}
          </Badge>
        </>
      }
      subtitle={
        <>
          {project.reference} · {project.organisation.name} · raised by{' '}
          {personName(project.createdBy)} on {formatDate(project.createdAt)}
        </>
      }
      tabs={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <SectionTabs
            basePath={detailPath}
            tabs={SECTIONS}
            active={section}
            preserve={{ buildId }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <BuildSwitcher basePath={detailPath} builds={project.builds} activeBuildId={activeBuildId} />
            {capabilities.canUpdate ? (
              <>
                <Button
                  href={`${detailPath}?section=${section}&buildId=${activeBuildId}&edit=rename-build`}
                  variant="ghost"
                  size="sm"
                >
                  Rename
                </Button>
                <Button
                  href={`${detailPath}?section=${section}&buildId=${activeBuildId}&edit=new-build`}
                  variant="secondary"
                  size="sm"
                  iconLeft="plus"
                >
                  New build
                </Button>
              </>
            ) : null}
          </div>
        </div>
      }
      aside={
        <>
          <Panel
            title="Status"
            description={`Now ${titleCase(project.status).toLowerCase()}. Only legal moves are listed.`}
          >
            {!capabilities.canChangeStatus ? (
              <Muted>
                You can read this project but not move it. That needs the project.write
                permission.
              </Muted>
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
                <Field
                  label="Note"
                  htmlFor="status-note"
                  hint="Recorded on the audit trail. Not sent to the customer."
                >
                  <Textarea
                    id="status-note"
                    name="note"
                    rows={3}
                    placeholder="Why is it moving?"
                    maxLength={1000}
                  />
                </Field>
                <Button type="submit" variant="primary" fullWidth>
                  Change status
                </Button>
              </form>
            )}
          </Panel>

          <Panel
            title="Priority and progress"
            description="Progress is the figure the delivery team reports, not a computed one."
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
                <Button type="submit" variant="secondary" fullWidth>
                  Save priority and progress
                </Button>
              </form>
            ) : (
              <div style={stackStyle}>
                <ProgressBar percent={project.progressPercent} />
                <Muted>Editing needs the project.write permission.</Muted>
              </div>
            )}
          </Panel>

          <Panel title="At a glance">
            <DescriptionList
              items={[
                {
                  label: 'Testers on the roster',
                  value: project.maxTesters
                    ? `${project._count.assignments} / ${project.maxTesters}`
                    : String(project._count.assignments),
                },
                { label: 'Bugs logged', value: String(project._count.bugs) },
                { label: 'Materials attached', value: String(project._count.materials) },
              ]}
            />
          </Panel>

          <Panel
            title="Managers"
            description="Internal owners. Assigned from the managers section."
          >
            {project.managers.length === 0 ? (
              <Muted>No manager oversees this project yet.</Muted>
            ) : (
              <ul style={listResetStyle}>
                {project.managers.map((row) => (
                  <li key={row.manager.id} style={rowStyle}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                      <span style={{ fontSize: 'var(--type-body-sm-size)' }}>
                        {personName(row.manager)}
                      </span>
                      <Caption>Since {formatDate(row.assignedAt)}</Caption>
                    </div>
                    <RoleBadge role={row.manager.role} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      }
    >
      {section === 'overview' ? (
        <>
      <Panel
        title="Overview"
        description="What the customer asked for and where it stands."
        actions={
          capabilities.canUpdate ? (
            <Button href={`${detailPath}?section=${section}&edit=brief`} variant="secondary" size="sm">
              Edit
            </Button>
          ) : undefined
        }
      >
        <DescriptionList items={overview} />
      </Panel>

      <Panel
        title="Project summary"
        description="Real-time metrics across every build on this project — testers, bugs and test cases."
      >
        {!projectReport ? (
          <Muted>Summary could not be loaded. Refresh in a moment.</Muted>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              {[
                { label: 'Testers', value: projectReport.testerCount },
                { label: 'Bugs', value: projectReport.bugs.total },
                { label: 'Test cases', value: projectReport.testCaseCount },
                { label: 'Builds', value: project.builds.length },
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

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 'var(--space-6)',
              }}
            >
              <DonutChart
                title="Bugs by severity"
                href={`/app/admin/bugs?projectId=${project.id}`}
                centerLabel={String(projectReport.bugs.total)}
                segments={Object.entries(projectReport.bugs.bySeverity).map(([label, value]) => ({
                  label: titleCase(label),
                  value,
                  tone: severityTone(label),
                }))}
              />
              <DonutChart
                title="Bugs by type"
                href={`/app/admin/bugs?projectId=${project.id}`}
                centerLabel={String(
                  Object.values(projectReport.bugs.byType).reduce((a, b) => a + b, 0),
                )}
                segments={Object.entries(projectReport.bugs.byType).map(([label, value]) => ({
                  label: titleCase(label),
                  value,
                  tone: bugTypeTone(label),
                }))}
              />
            </div>

            <BarChart
              title="Bugs by status"
              href={`/app/admin/bugs?projectId=${project.id}`}
              segments={Object.entries(projectReport.bugs.byStatus).map(([label, value]) => ({
                label: titleCase(label),
                value,
                tone: statusTone(label),
              }))}
            />

            <BarChart
              title="Testers by country"
              href={`${detailPath}?section=testers`}
              segments={Object.entries(projectReport.testersByCountry).map(([label, value]) => ({
                label,
                value,
                tone: 'info' as const,
              }))}
            />
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
                  pattern="\s*[A-Za-z]{2}\s*(,\s*[A-Za-z]{2}\s*)*"
                  title="Two-letter country codes separated by commas"
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
                  pattern="\s*[A-Za-z]{2}\s*(,\s*[A-Za-z]{2}\s*)*"
                  title="Two-letter language codes separated by commas"
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

              <Field label="End date" htmlFor="endDate" hint="Must not fall before the start date.">
                <Input
                  id="endDate"
                  name="endDate"
                  type="date"
                  defaultValue={toDateInput(project.endDate)}
                />
              </Field>

              <Field label="Maximum testers" htmlFor="maxTesters" hint="Leave blank for no cap.">
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
              <Button type="submit" variant="primary">
                Save the brief
              </Button>
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
                  variant="secondary"
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
                        style={{ color: 'var(--text-brand)', textDecoration: 'underline', textUnderlineOffset: 3 }}
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
                  { label: 'Target countries', value: <TokenList values={buildDetail.targetCountries} /> },
                  {
                    label: 'Target languages',
                    value: <TokenList values={buildDetail.targetLanguages} uppercase={false} />,
                  },
                  { label: 'Target devices', value: <TokenList values={buildDetail.targetDevices} uppercase={false} /> },
                  {
                    label: 'Target browsers',
                    value: <TokenList values={buildDetail.targetBrowsers} uppercase={false} />,
                  },
                  {
                    label: 'Target operating systems',
                    value: <TokenList values={buildDetail.targetOperatingSystems} uppercase={false} />,
                  },
                  {
                    label: 'Features',
                    wide: true,
                    value: buildDetail.description ? <Prose>{buildDetail.description}</Prose> : '',
                  },
                  {
                    label: 'Testing instructions',
                    wide: true,
                    value: buildDetail.instructions ? <Prose>{buildDetail.instructions}</Prose> : '',
                  },
                  {
                    label: 'Special requirements',
                    wide: true,
                    value: buildDetail.specialRequirements ? <Prose>{buildDetail.specialRequirements}</Prose> : '',
                  },
                  {
                    label: 'Release notes',
                    wide: true,
                    value: buildDetail.releaseNotes ? <Prose>{buildDetail.releaseNotes}</Prose> : '',
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
                <Button type="submit" variant="secondary" iconLeft="repeat">
                  Copy this build
                </Button>
              </form>
              <Button
                href={`/app/admin/export/reports/by-build/${activeBuildId}/export.csv`}
                prefetch={false}
                variant="secondary"
                iconLeft="download"
              >
                Download report
              </Button>
            </div>
          ) : null}

          <Panel
            title="Summary"
            description="Real-time metrics for this build — testers, bugs and test-case execution."
          >
            {!buildSummaryData ? (
              <Muted>Summary could not be loaded. Refresh in a moment.</Muted>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-4)' }}>
                  {[
                    { label: 'Testers', value: buildSummaryData.testerCount },
                    { label: 'Bugs', value: buildSummaryData.bugCount },
                    { label: 'Test cases', value: buildSummaryData.testCaseCount },
                    {
                      label: 'Test completion',
                      value: buildSummaryData.testCaseCompletion === null ? '—' : `${buildSummaryData.testCaseCompletion}%`,
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

                <BarChart
                  title="Bugs by severity"
                  segments={Object.entries(buildSummaryData.bugsBySeverity).map(([label, value]) => ({
                    label: titleCase(label),
                    value,
                    tone: severityTone(label),
                  }))}
                />
                <BarChart
                  title="Bugs by status"
                  segments={Object.entries(buildSummaryData.bugsByStatus).map(([label, value]) => ({
                    label: titleCase(label),
                    value,
                    tone: statusTone(label),
                  }))}
                />
                <DonutChart
                  title="Test reports by result"
                  centerLabel={String(
                    Object.values(buildSummaryData.testReportsByResult).reduce((a, b) => a + b, 0),
                  )}
                  segments={Object.entries(buildSummaryData.testReportsByResult).map(([label, value]) => ({
                    label: titleCase(label),
                    value,
                    tone:
                      label === 'PASS' ? 'success' : label === 'FAIL' ? 'error' : label === 'BLOCKED' ? 'warning' : 'neutral',
                  }))}
                />

                {buildSummaryData.reviewCount > 0 ? (
                  <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
                    {buildSummaryData.reviewCount} review{buildSummaryData.reviewCount === 1 ? '' : 's'}
                    {buildSummaryData.averageRating !== null
                      ? ` · average rating ${buildSummaryData.averageRating.toFixed(1)} / 5`
                      : ''}
                  </p>
                ) : null}
              </div>
            )}
          </Panel>
        </>
      ) : null}

      {capabilities.canUpdate && buildDetail ? (
        <Modal open={buildDetailsModalOpen} closedHref={closedHref} title="Edit build details">
          <TrackedForm action={updateBuild} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="buildId" value={activeBuildId} />

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
              <Field label="Test type" htmlFor="build-testType" hint="Exploratory, regression, smoke, load...">
                <Input id="build-testType" name="testType" maxLength={120} defaultValue={buildDetail.testType ?? ''} />
              </Field>
              <Field label="Start date" htmlFor="build-startDate">
                <Input id="build-startDate" name="startDate" type="date" defaultValue={toDateInput(buildDetail.startDate)} />
              </Field>
              <Field label="End date" htmlFor="build-endDate">
                <Input id="build-endDate" name="endDate" type="date" defaultValue={toDateInput(buildDetail.endDate)} />
              </Field>
              <Field label="Maximum testers" htmlFor="build-maxTesters" hint="Leave blank for no cap.">
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
                <Input id="build-appUrl" name="appUrl" type="url" maxLength={2000} defaultValue={buildDetail.appUrl ?? ''} />
              </Field>
            </div>

            <div style={fieldGridStyle}>
              <Field label="Target countries" htmlFor="build-targetCountries" hint="Comma separated: IN, GB, US.">
                <Input
                  id="build-targetCountries"
                  name="targetCountries"
                  defaultValue={buildDetail.targetCountries.join(', ')}
                />
              </Field>
              <Field label="Target languages" htmlFor="build-targetLanguages" hint="Comma separated: en, hi, ta.">
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
              <Textarea id="build-description" name="description" rows={3} defaultValue={buildDetail.description ?? ''} />
            </Field>
            <Field label="Testing instructions" htmlFor="build-instructions">
              <Textarea id="build-instructions" name="instructions" rows={6} defaultValue={buildDetail.instructions ?? ''} />
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
              <Textarea id="build-releaseNotes" name="releaseNotes" rows={3} defaultValue={buildDetail.releaseNotes ?? ''} />
            </Field>

            <Checkbox
              name="testersCanSeeOtherBugs"
              defaultChecked={buildDetail.testersCanSeeOtherBugs ?? false}
              label="Testers can see bugs raised by others (this build)"
              description="Overrides the project's own setting for this build only."
            />

            <div>
              <Button type="submit" variant="primary">
                Save build details
              </Button>
            </div>
          </TrackedForm>
        </Modal>
      ) : null}

      {section === 'testers' ? (
        <>
      <Panel
        title="Tester roster"
        description={`${project.assignments.length} tester${
          project.assignments.length === 1 ? '' : 's'
        } invited to ${activeBuild?.name ?? 'this build'}.`}
        flush
      >
        <Table
          ariaLabel="Tester roster"
          columns={assignmentColumns}
          rows={project.assignments}
          rowKey={(row) => row.tester.id}
          style={bareTableStyle}
          emptyState={
            <div style={{ padding: 'var(--space-6)' }}>
              <Muted>
                Nobody is on this project yet. Invite verified testers below and they will be asked
                to accept.
              </Muted>
            </div>
          }
        />
      </Panel>

      {capabilities.canAssignTesters ? (
        <>
          <Panel
            title="Invite testers"
            description="Verified testers who have accepted the NDA and are not already on the roster."
          >
            {'error' in testerPool ? (
              <Muted>
                The tester pool could not be read. Inviting from here needs the tester.read
                permission as well as project.assign.
              </Muted>
            ) : invitable.length === 0 ? (
              <Muted>
                Every verified tester in the top {TESTER_POOL_SIZE} by rating is already on this
                roster. Verify more testers to widen the pool.
              </Muted>
            ) : (
              <form action={inviteTesters} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <input type="hidden" name="buildId" value={activeBuildId} />
                <fieldset style={fieldsetStyle}>
                  <legend
                    className="c4t-eyebrow"
                    style={{ color: 'var(--text-muted)', padding: 0 }}
                  >
                    Choose testers
                  </legend>
                  <div style={checkboxGridStyle}>
                    {invitable.map((tester) => {
                      const fit = deviceFitsTargets(tester.devices, project.platformTargets)
                      return (
                        <Checkbox
                          key={tester.user.id}
                          id={`tester-${tester.user.id}`}
                          name="testerIds"
                          value={tester.user.id}
                          label={personName(tester.user)}
                          description={`${tester.user.email} · ${
                            tester.countryCode ?? 'no country'
                          } · ${formatRating(tester.ratingAverage)}${
                            fit === 'mismatch' ? ' · no device on this platform' : ''
                          }`}
                        />
                      )
                    })}
                  </div>
                </fieldset>
                <Field
                  label="Note to the testers"
                  htmlFor="invite-notes"
                  hint="Sent with the invitation. Keep it to what they need to decide."
                >
                  <Textarea
                    id="invite-notes"
                    name="notes"
                    rows={3}
                    maxLength={1000}
                    placeholder="What is the ask, and by when?"
                  />
                </Field>
                <div>
                  <Button type="submit" variant="primary" iconLeft="user-check">
                    Invite selected testers
                  </Button>
                </div>
              </form>
            )}
          </Panel>

          {project.assignments.length > 0 ? (
            <Panel
              title="Update an assignment"
              description="Activate a tester who accepted, mark their work complete, or take them off."
            >
              <form action={updateAssignment} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <div style={fieldGridStyle}>
                  <Field label="Tester" htmlFor="assignment-tester" required>
                    <Select
                      id="assignment-tester"
                      name="testerId"
                      required
                      options={project.assignments.map((row) => ({
                        value: row.tester.id,
                        label: `${personName(row.tester)} · ${titleCase(row.status)}`,
                      }))}
                    />
                  </Field>
                  <Field label="New assignment status" htmlFor="assignment-status" required>
                    <Select
                      id="assignment-status"
                      name="status"
                      required
                      options={ASSIGNMENT_STATUSES.map((value) => ({
                        value,
                        label: titleCase(value),
                      }))}
                      defaultValue="ACTIVE"
                    />
                  </Field>
                </div>
                <Field
                  label="Note"
                  htmlFor="assignment-notes"
                  hint="Replaces the note on that assignment. Leave blank to keep the current one."
                >
                  <Textarea id="assignment-notes" name="notes" rows={3} maxLength={1000} />
                </Field>
                <div>
                  <Button type="submit" variant="secondary">
                    Update assignment
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}
        </>
      ) : (
        <Panel title="Invite testers">
          <Muted>
            Staffing this project needs the project.assign permission. Ask an administrator to
            grant it.
          </Muted>
        </Panel>
      )}
        </>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  <span style={{ fontSize: 'var(--type-body-sm-size)' }}>{material.title}</span>
                  {material.description ? <Caption>{material.description}</Caption> : null}
                  <MaterialTarget material={material} />
                  <Caption>Added {formatDate(material.createdAt)}</Caption>
                </div>
                {capabilities.canManageMaterials ? (
                  <form action={removeMaterial}>
                    <input type="hidden" name="id" value={project.id} />
                    <input type="hidden" name="materialId" value={material.id} />
                    <Button type="submit" variant="ghost" size="sm" iconLeft="x">
                      Remove
                    </Button>
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
              <Textarea id="material-description" name="description" rows={3} maxLength={2000} />
            </Field>
            <div>
              <Button type="submit" variant="secondary" iconLeft="plus">
                Attach material
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}
        </>
      ) : null}

      {section === 'features' ? (
        <>
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
                    <Button type="submit" variant="ghost" size="sm" iconLeft="x">
                      Remove
                    </Button>
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
            <Button type="submit" variant="secondary" iconLeft="plus">
              Add feature
            </Button>
          </form>
        ) : null}
      </Panel>
        </>
      ) : null}

      {section === 'testing' ? (
        <>
          <Panel
            title="Test cases"
            description={
              'error' in testCases
                ? 'Test cases could not be loaded.'
                : `${testCases.meta.total} test case${testCases.meta.total === 1 ? '' : 's'} on ${activeBuild?.name ?? 'this build'}. A test case is a scripted check; a bug is a defect it can turn up — the two lists are kept separate.`
            }
          >
            {'error' in testCases ? (
              <Muted>
                {testCases.error === 'forbidden'
                  ? 'Reading test cases needs the project.read permission.'
                  : 'The testing service is unreachable. Refresh in a moment.'}
              </Muted>
            ) : testCases.items.length === 0 ? (
              <Muted>No test cases written for this build yet.</Muted>
            ) : (
              <ul style={listResetStyle}>
                {testCases.items.map((tc) => {
                  const assignedIds = new Set(tc.assignments.map((a) => a.tester.id))
                  const assignableTesters = project.assignments.filter(
                    (a) => !assignedIds.has(a.tester.id),
                  )
                  return (
                    <li key={tc.id} style={{ ...rowStyle, flexDirection: 'column', alignItems: 'stretch' }}>
                      <details>
                        <summary
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-3)',
                            cursor: 'pointer',
                            listStyle: 'none',
                          }}
                        >
                          <strong style={{ color: 'var(--text-primary)', flex: 1 }}>{tc.title}</strong>
                          {tc.feature ? <Badge tone="neutral">{tc.feature}</Badge> : null}
                          <Caption>
                            {tc.assignments.length} assigned · {tc._count.reports} report
                            {tc._count.reports === 1 ? '' : 's'}
                          </Caption>
                        </summary>

                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 'var(--space-4)',
                            marginTop: 'var(--space-4)',
                            paddingLeft: 'var(--space-2)',
                          }}
                        >
                          <DescriptionList
                            items={[
                              { label: 'Description', wide: true, value: <Prose>{tc.description}</Prose> },
                              { label: 'Steps', wide: true, value: <Prose>{tc.steps}</Prose> },
                              { label: 'Expected result', wide: true, value: <Prose>{tc.expectedResult}</Prose> },
                            ]}
                          />

                          <div>
                            <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-2)' }}>
                              Assigned testers
                            </p>
                            {tc.assignments.length === 0 ? (
                              <Muted>Nobody is assigned yet.</Muted>
                            ) : (
                              <ul style={{ ...listResetStyle, gap: 'var(--space-1)' }}>
                                {tc.assignments.map((a) => (
                                  <li key={a.id} style={{ fontSize: 'var(--type-body-sm-size)' }}>
                                    {personName(a.tester)}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {capabilities.canAssignTesters && assignableTesters.length > 0 ? (
                              <form
                                action={assignTestCase}
                                style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}
                              >
                                <input type="hidden" name="id" value={project.id} />
                                <input type="hidden" name="testCaseId" value={tc.id} />
                                <Select
                                  name="testerId"
                                  required
                                  placeholder="Pick a tester"
                                  options={assignableTesters.map((a) => ({
                                    value: a.tester.id,
                                    label: personName(a.tester),
                                  }))}
                                />
                                <Button type="submit" variant="ghost" size="sm">
                                  Assign
                                </Button>
                              </form>
                            ) : null}
                          </div>

                          <div>
                            <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-2)' }}>
                              Test reports
                            </p>
                            {tc.reports.length === 0 ? (
                              <Muted>No report filed yet.</Muted>
                            ) : (
                              <ul style={{ ...listResetStyle, gap: 'var(--space-3)' }}>
                                {tc.reports.map((r) => (
                                  <li key={r.id} style={{ fontSize: 'var(--type-body-sm-size)' }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                      <StatusBadge status={r.result} />
                                      <span>{personName(r.tester)}</span>
                                      <Caption>{formatDate(r.createdAt)}</Caption>
                                    </span>
                                    {r.notes ? (
                                      <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-secondary)' }}>
                                        {r.notes}
                                      </p>
                                    ) : null}
                                    {r.linkedBug ? (
                                      <Link
                                        href={`/app/admin/bugs/${r.linkedBug.id}`}
                                        style={{ color: 'var(--text-brand)', textDecoration: 'underline', textUnderlineOffset: 3 }}
                                      >
                                        {r.linkedBug.reference} — {r.linkedBug.title}
                                      </Link>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      </details>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>

          {capabilities.canAssignTesters ? (
            <Panel
              title="Add a test case"
              description="A scripted check testers on this build can be assigned to run."
            >
              <form action={createTestCase} style={stackStyle}>
                <input type="hidden" name="id" value={project.id} />
                <input type="hidden" name="buildId" value={activeBuildId} />
                <div style={fieldGridStyle}>
                  <Field label="Title" htmlFor="tc-title" required>
                    <Input id="tc-title" name="title" required minLength={3} maxLength={200} />
                  </Field>
                  <Field label="Feature" htmlFor="tc-feature" hint="Optional — free text.">
                    <Input id="tc-feature" name="feature" maxLength={160} />
                  </Field>
                </div>
                <Field label="Description" htmlFor="tc-description" required>
                  <Textarea id="tc-description" name="description" rows={3} required minLength={5} />
                </Field>
                <Field label="Steps" htmlFor="tc-steps" required>
                  <Textarea id="tc-steps" name="steps" rows={4} required minLength={5} />
                </Field>
                <Field label="Expected result" htmlFor="tc-expectedResult" required>
                  <Textarea id="tc-expectedResult" name="expectedResult" rows={2} required />
                </Field>
                <div>
                  <Button type="submit" variant="primary" iconLeft="plus">
                    Add test case
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}
        </>
      ) : null}

      {section === 'bugs' ? (
        <>
      <Panel
        title="Bugs"
        description={
          'error' in bugs
            ? 'This build’s reports.'
            : bugs.meta.total > BUG_PREVIEW_SIZE
              ? `The ${BUG_PREVIEW_SIZE} most recent of ${bugs.meta.total} reports on ${activeBuild?.name ?? 'this build'}.`
              : `${bugs.meta.total} report${bugs.meta.total === 1 ? '' : 's'} on ${activeBuild?.name ?? 'this build'}.`
        }
        flush
      >
        {'error' in bugs ? (
          <div style={{ padding: 'var(--space-6)' }}>
            <Muted>
              {bugs.error === 'forbidden'
                ? 'Reading defects needs the bug.read permission.'
                : 'The bugs service is unreachable. Refresh in a moment.'}
            </Muted>
          </div>
        ) : (
          <Table
            ariaLabel="Bugs on this project"
            columns={bugColumns}
            rows={bugs.items}
            rowKey={(row) => row.id}
            rowHref={(row) => `/app/admin/bugs/${row.id}`}
            style={bareTableStyle}
            emptyState={
              <div style={{ padding: 'var(--space-6)' }}>
                <Muted>No defect has been logged against this project yet.</Muted>
              </div>
            }
          />
        )}
      </Panel>
        </>
      ) : null}

      {section === 'settings' ? (
        <>
      {canDelete ? (
        <Panel
          title="Archive this project"
          description="The project is soft-deleted and its status set to cancelled. Bugs, materials and the roster are kept."
        >
          <form action={archiveProject} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="reference" value={project.reference} />
            <Field
              label={`Type ${project.reference} to confirm`}
              htmlFor="confirm"
              hint="Nothing happens unless the reference matches."
            >
              <Input id="confirm" name="confirm" required autoComplete="off" />
            </Field>
            <div>
              <Button type="submit" variant="secondary" iconLeft="alert-triangle">
                Archive project
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}
        </>
      ) : null}

      {capabilities.canUpdate ? (
        <Modal open={newBuildModalOpen} closedHref={closedHref} title="New build">
          <form action={createBuild} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="section" value={section} />
            <Field
              label="Name"
              htmlFor="new-build-name"
              hint="For example: Build 1.2, or Release candidate 3."
            >
              <Input id="new-build-name" name="name" required maxLength={120} autoFocus />
            </Field>
            <Button type="submit" variant="primary" fullWidth>
              Create build
            </Button>
          </form>
        </Modal>
      ) : null}

      {capabilities.canUpdate && activeBuild ? (
        <Modal open={renameBuildModalOpen} closedHref={closedHref} title="Rename build">
          <form action={renameBuild} style={stackStyle}>
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="buildId" value={activeBuild.id} />
            <Field label="Name" htmlFor="rename-build-name">
              <Input
                id="rename-build-name"
                name="name"
                required
                maxLength={120}
                defaultValue={activeBuild.name}
              />
            </Field>
            <Button type="submit" variant="primary" fullWidth>
              Save name
            </Button>
          </form>
        </Modal>
      ) : null}
    </DetailShell>
  )
}

// ─── Local presentation helpers ──────────────────────────────────────────────
// These are page-local on purpose: none of them is general enough to earn a
// place in components/admin, and the shared shells already own the layout.

const stackStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-5)',
}

const fieldGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 'var(--space-5)',
}

const checkboxGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 'var(--space-4)',
}

const fieldsetStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-4)',
  margin: 0,
  padding: 0,
  border: 'none',
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

/**
 * The table already draws a border and a radius, which reads as a card inside a
 * card when it sits in a flush panel. Stripping them lets the panel own the
 * frame while the table keeps its sunken header row.
 */
const bareTableStyle = {
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
}

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

/** Long free text from the customer. Their line breaks are meaningful. */
function Prose({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'block', whiteSpace: 'pre-wrap', maxWidth: '75ch' }}>{children}</span>
  )
}

/** Renders a string array as pills, or an em dash when it is empty. */
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

/** A material points at either an uploaded file or an external link, never both. */
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

/** `2026-08-14T12:09:18.713Z` → `2026-08-14`, which is what a date input wants. */
function toDateInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

/**
 * `ratingAverage` is a Prisma Decimal, which serialises to a JSON string — so
 * `toFixed` on the raw value would throw. Coerced first, every time.
 */
function formatRating(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const score = Number(value)
  return Number.isFinite(score) ? `${score.toFixed(1)} / 5` : '—'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

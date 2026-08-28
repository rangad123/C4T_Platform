import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge, SeverityBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Textarea } from '@/components/ds/forms/Textarea'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'
import { formatDate, formatDateTime, personName, titleCase } from '@/lib/admin/format'
import { DownloadLink } from '@/components/tester/DownloadLink'
import { respondToInvitation } from './actions'
import type {
  AnnouncementRow,
  BugRow,
  BuildDetail,
  ProjectDetail,
  ProjectFeature,
  ProjectMaterial,
} from './constants'

const ROOT = { label: 'Tester', href: '/app/tester' }
const LIST_PATH = '/app/tester/projects'
const BUG_PAGE_SIZE = 50

/**
 * `/app/tester/projects/[id]` — the tester's workspace for one project.
 *
 * This is the page the whole tester portal exists to serve: read the brief,
 * see what you are expected to test on, file defects against it. It mirrors
 * the admin project page's shape (DetailShell + SectionTabs + section-gated
 * fetches) so a tester and an admin looking at the same project recognise
 * the same furniture.
 *
 * ── One build, not a switcher
 *
 * The admin page carries a `BuildSwitcher` because an admin owns every build
 * on a project. A tester is assigned to exactly ONE — `ProjectAssignment` is
 * unique on `[projectId, testerId]` — and the API returns it as
 * `activeBuildId` regardless of what `?buildId=` says. So there is no
 * switcher here: showing one would imply a choice the tester does not have.
 *
 * ── Why the fetches are section-gated
 *
 * Each tab's data is fetched only when that tab is open. Opening "Build
 * details" should not wait on the bug list, and a tester on a slow connection
 * feels that difference. Same pattern as the admin and customer project
 * pages.
 */

const NOTICES: Record<string, NoticeCopy> = {
  accepted: {
    tone: 'success',
    message: 'You are on the project. The brief and the full build details are open to you now.',
  },
  declined: { tone: 'success', message: 'You declined the invitation. Nothing further is expected.' },
  answered: {
    tone: 'warning',
    message: 'That invitation was already answered — this page has the current state.',
  },
  invalid: { tone: 'error', message: 'That response was not recognised. Try again.' },
  forbidden: { tone: 'error', message: 'You are not able to answer this invitation.' },
  missing: { tone: 'error', message: 'That invitation is no longer there. Reload the page.' },
  failed: { tone: 'error', message: 'That did not go through. Try again in a moment.' },
}


export default async function TesterProjectWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ section?: string; notice?: string }>
}) {
  const user = await requireRole(['TESTER'])
  const { id } = await params
  const { section: rawSection, notice } = await searchParams

  let project: ProjectDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    project = await serverFetch<ProjectDetail>(`projects/${id}`)
  } catch (err) {
    // The API answers an out-of-scope project with 404 rather than 403 on
    // purpose — a 403 would confirm the project exists to someone who has no
    // business knowing that.
    if (err instanceof ApiError && err.status === 404) notFound()
    if (err instanceof ApiError && err.status === 403) loadError = 'forbidden'
    else loadError = 'unknown'
  }

  if (loadError !== null || project === null) {
    return (
      <DetailShell
        root={ROOT}
        crumbs={[{ label: 'Projects', href: LIST_PATH }, { label: 'Unavailable' }]}
        eyebrow="Work"
        title="Unavailable"
      >
        <EmptyState
          icon={loadError === 'forbidden' ? 'lock' : 'alert-triangle'}
          title={
            loadError === 'forbidden'
              ? "You don't have access to this project"
              : "Couldn't load this project"
          }
          description={
            loadError === 'forbidden'
              ? 'You are not assigned to it.'
              : 'The projects service is unreachable. Refresh in a moment.'
          }
          action={
            <Button variant="secondary" href={LIST_PATH} iconLeft="arrow-left">
              Back to projects
            </Button>
          }
        />
      </DetailShell>
    )
  }

  const { capabilities } = project
  const activeBuildId = project.activeBuildId
  const activeBuild = project.builds.find((b) => b.id === activeBuildId)
  const myAssignment = project.assignments[0] ?? null
  const assignmentStatus = capabilities.myAssignmentStatus ?? myAssignment?.status ?? null
  const isInvited = assignmentStatus === 'INVITED'

  /**
   * An INVITED tester has not accepted yet, so the API withholds the brief
   * (`project.read_brief` excludes `project:tester_invited`). Showing tabs
   * that would all render "not available to you" is worse than showing the
   * invitation on its own, so the tab strip is suppressed until they answer.
   */
  const SECTIONS = [
    { value: 'build', label: 'Build details', icon: 'file-text' },
    { value: 'bugs', label: 'Bugs', icon: 'clipboard-check' },
    ...(project.testersCanSeeOtherBugs
      ? ([{ value: 'bugs-others', label: 'Bugs (others)', icon: 'users' }] as const)
      : []),
    { value: 'announcements', label: 'Announcements', icon: 'message-square' },
  ] as const
  const section = resolveSection(SECTIONS, rawSection)
  const detailPath = `${LIST_PATH}/${project.id}`

  /**
   * Section-gated reads. `Promise.resolve(null)` for a tab that is not open
   * keeps the shape of the tuple without paying for the request.
   */
  const [buildDetail, features, myBugs, otherBugs, announcements] = await Promise.all([
    !isInvited && section === 'build'
      ? serverFetchOrNull<BuildDetail>(`projects/${project.id}/builds/${activeBuildId}`)
      : Promise.resolve(null),
    !isInvited && section === 'build'
      ? serverFetchOrNull<readonly ProjectFeature[]>(`projects/${project.id}/features`, {
          query: { buildId: activeBuildId },
        })
      : Promise.resolve(null),
    !isInvited && section === 'bugs'
      ? serverFetchOrNull<readonly BugRow[]>('bugs', {
          query: {
            buildId: activeBuildId,
            reportedById: user.id,
            limit: BUG_PAGE_SIZE,
            sort: 'createdAt',
            order: 'desc',
          },
        })
      : Promise.resolve(null),
    !isInvited && section === 'bugs-others'
      ? serverFetchOrNull<readonly BugRow[]>('bugs', {
          query: {
            buildId: activeBuildId,
            excludeReportedById: user.id,
            limit: BUG_PAGE_SIZE,
            sort: 'createdAt',
            order: 'desc',
          },
        })
      : Promise.resolve(null),
    !isInvited && section === 'announcements'
      ? serverFetchOrNull<readonly AnnouncementRow[]>('communication/announcements', {
          // Scoped to this project and this tester's build. Without the
          // filter this tab showed every announcement the tester could see
          // platform-wide, which on a project workspace reads as though they
          // all concern this project.
          query: { projectId: project.id, buildId: activeBuildId, limit: 50 },
        })
      : Promise.resolve(null),
  ])

  /**
   * Already narrowed server-side to this project and this tester's build,
   * plus the project- and platform-wide notices that apply here. This used to
   * be a client-side filter over the tester's whole feed, which could not see
   * `buildId` at all and so showed other builds' announcements.
   */
  const relevantAnnouncements = announcements ?? []

  const bugColumns: readonly TableColumn<BugRow>[] = [
    {
      key: 'title',
      header: 'Bug',
      render: (row) => row.title,
      renderSecondary: (row) => [row.reference, row.feature?.name].filter(Boolean).join(' · '),
    },
    { key: 'severity', header: 'Severity', render: (row) => <SeverityBadge severity={row.severity} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'type', header: 'Type', render: (row) => (row.type ? titleCase(row.type) : '—') },
    { key: 'logged', header: 'Reported', align: 'right', render: (row) => formatDate(row.createdAt) },
  ]

  const otherBugColumns: readonly TableColumn<BugRow>[] = [
    ...bugColumns.slice(0, 4),
    { key: 'reporter', header: 'Reported by', render: (row) => personName(row.reportedBy) },
    { key: 'logged', header: 'Reported', align: 'right', render: (row) => formatDate(row.createdAt) },
  ]

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Projects', href: LIST_PATH }, { label: project.reference }]}
      eyebrow="Work"
      title={project.title}
      badges={
        <>
          {assignmentStatus ? <StatusBadge status={assignmentStatus} /> : null}
          <StatusBadge status={project.status} />
        </>
      }
      subtitle={
        <>
          {project.reference} · {project.organisation.name}
          {activeBuild ? ` · ${activeBuild.name}` : ''}
        </>
      }
      tabs={isInvited ? undefined : <SectionTabs basePath={detailPath} tabs={SECTIONS} active={section} />}
      aside={
        isInvited ? undefined : (
          <>
            <Panel title="Your assignment" description="Where you stand on this project.">
              <DescriptionList
                items={[
                  { label: 'Status', value: assignmentStatus ? <StatusBadge status={assignmentStatus} /> : '—' },
                  { label: 'Invited', value: formatDate(myAssignment?.invitedAt ?? null) },
                  { label: 'Responded', value: formatDate(myAssignment?.respondedAt ?? null) },
                  { label: 'Completed', value: formatDate(myAssignment?.completedAt ?? null) },
                  { label: 'Build', value: activeBuild?.name ?? '—' },
                ]}
              />
              {myAssignment?.notes ? (
                <p
                  style={{
                    marginTop: 'var(--space-5)',
                    paddingTop: 'var(--space-5)',
                    borderTop: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    fontSize: 'var(--type-body-sm-size)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {myAssignment.notes}
                </p>
              ) : null}
            </Panel>

            {capabilities.canReportBug ? (
              <Panel title="Found something?" description="File it against this build while it is fresh.">
                <Button
                  href={`/app/tester/bugs/new?projectId=${project.id}&buildId=${activeBuildId}`}
                  variant="primary"
                  iconLeft="plus"
                  fullWidth
                >
                  Report a bug
                </Button>
              </Panel>
            ) : null}
          </>
        )
      }
    >
      <Notice code={notice} notices={NOTICES} />

      {/* ── The invitation, when it is still open ─────────────────────── */}
      {isInvited ? (
        <Panel
          title="You have been invited to this project"
          description="Accept to see the full brief, the build details and the testing scope. Declining tells the project owner not to expect reports from you."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <DescriptionList
              items={[
                { label: 'Project', value: project.title },
                { label: 'Organisation', value: project.organisation.name },
                { label: 'Summary', wide: true, value: project.summary ?? '—' },
                {
                  label: 'Window',
                  value: `${formatDate(project.startDate)} to ${formatDate(project.endDate)}`,
                },
                { label: 'Platforms', value: <TokenList values={project.platformTargets} /> },
                { label: 'Invited', value: formatDate(myAssignment?.invitedAt ?? null) },
              ]}
            />

            <form action={respondToInvitation} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <input type="hidden" name="id" value={project.id} />
              <Field
                label="Note"
                htmlFor="respond-notes"
                hint="Optional. Sent to the project owner with your answer."
              >
                <Textarea id="respond-notes" name="notes" rows={3} maxLength={1000} />
              </Field>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <SubmitButton
                  name="response"
                  value="ACCEPTED"
                  variant="primary"
                  iconLeft="check"
                  pendingLabel="Accepting…"
                >
                  Accept invitation
                </SubmitButton>
                <SubmitButton
                  name="response"
                  value="DECLINED"
                  variant="secondary"
                  pendingLabel="Declining…"
                >
                  Decline
                </SubmitButton>
              </div>
            </form>
          </div>
        </Panel>
      ) : null}

      {/* ── Build details ────────────────────────────────────────────── */}
      {!isInvited && section === 'build' ? (
        <>
          <Panel
            title="Test details"
            description="What this test cycle covers, and the window you have to do it in."
          >
            {!buildDetail ? (
              <Muted>Build details could not be loaded. Refresh in a moment.</Muted>
            ) : (
              <DescriptionList
                items={[
                  { label: 'Status', value: <StatusBadge status={buildDetail.status} /> },
                  { label: 'Test type', value: buildDetail.testType ?? '—' },
                  { label: 'Test start date', value: formatDate(buildDetail.startDate) },
                  { label: 'Test end date', value: formatDate(buildDetail.endDate) },
                  {
                    label: 'Application / website URL',
                    wide: true,
                    value: buildDetail.appUrl ? (
                      <a
                        href={buildDetail.appUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{
                          color: 'var(--text-brand)',
                          textDecoration: 'underline',
                          textUnderlineOffset: 3,
                          wordBreak: 'break-all',
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
                    wide: true,
                    value: buildDetail.testDocument ? (
                      <DownloadLink
                        fileId={buildDetail.testDocument.id}
                        name={buildDetail.testDocument.originalName}
                      />
                    ) : (
                      '—'
                    ),
                  },
                  { label: 'Countries', value: <TokenList values={buildDetail.targetCountries} /> },
                  {
                    label: 'Languages',
                    value: <TokenList values={buildDetail.targetLanguages} uppercase={false} />,
                  },
                  {
                    label: 'Features',
                    wide: true,
                    value:
                      features && features.length > 0 ? (
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                          {features.map((f) => (
                            <Badge key={f.id} tone="accent" uppercase={false}>
                              {f.name}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
            )}
          </Panel>

          <Panel
            title="Device details"
            description="The environment this build is meant to be tested on."
          >
            {!buildDetail ? (
              <Muted>Not available.</Muted>
            ) : (
              <DescriptionList
                items={[
                  {
                    label: 'Application type',
                    value: <TokenList values={project.platformTargets} uppercase={false} />,
                  },
                  {
                    label: 'Operating systems',
                    value: <TokenList values={buildDetail.targetOperatingSystems} uppercase={false} />,
                  },
                  {
                    label: 'Browsers',
                    value: <TokenList values={buildDetail.targetBrowsers} uppercase={false} />,
                  },
                  {
                    label: 'Devices',
                    value: <TokenList values={buildDetail.targetDevices} uppercase={false} />,
                  },
                ]}
              />
            )}
          </Panel>

          {buildDetail?.instructions ? (
            <Panel title="Testing to be done" description="Follow this as written.">
              <Prose>{buildDetail.instructions}</Prose>
            </Panel>
          ) : null}

          {buildDetail?.specialRequirements ? (
            <Panel title="Special requirements">
              <Prose>{buildDetail.specialRequirements}</Prose>
            </Panel>
          ) : null}

          {buildDetail?.releaseNotes ? (
            <Panel title="Release notes">
              <Prose>{buildDetail.releaseNotes}</Prose>
            </Panel>
          ) : null}

          <Panel
            title="Materials"
            description="Builds, credentials and reference documents attached to this test cycle."
          >
            {project.materials.length === 0 ? (
              <Muted>No material is attached to this build.</Muted>
            ) : (
              <ul style={listResetStyle}>
                {project.materials.map((material) => (
                  <li key={material.id} style={rowStyle}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                      <span style={{ fontSize: 'var(--type-body-sm-size)' }}>{material.title}</span>
                      {material.description ? <Caption>{material.description}</Caption> : null}
                      <MaterialTarget material={material} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}

      {/* ── My bugs on this build ────────────────────────────────────── */}
      {!isInvited && section === 'bugs' ? (
        <Panel
          title="Your bugs"
          description="Defects you filed against this build."
          actions={
            capabilities.canReportBug ? (
              <Button
                href={`/app/tester/bugs/new?projectId=${project.id}&buildId=${activeBuildId}`}
                variant="primary"
                size="sm"
                iconLeft="plus"
              >
                Report a bug
              </Button>
            ) : undefined
          }
          flush
        >
          {!myBugs ? (
            <div style={{ padding: 'var(--space-6)' }}>
              <Muted>The bugs service is unreachable. Refresh in a moment.</Muted>
            </div>
          ) : (
            <Table
              ariaLabel="Your bugs on this build"
              columns={bugColumns}
              rows={myBugs}
              rowKey={(row) => row.id}
              rowHref={(row) => `/app/tester/bugs/${row.id}`}
              style={bareTableStyle}
              emptyState={
                <div style={{ padding: 'var(--space-6)' }}>
                  <Muted>You have not filed anything against this build yet.</Muted>
                </div>
              }
            />
          )}
        </Panel>
      ) : null}

      {/* ── Everyone else's bugs, when the project allows it ─────────── */}
      {!isInvited && section === 'bugs-others' ? (
        <Panel
          title="Bugs from other testers"
          description="Reports filed by the rest of the crowd on this build. Read them before filing — a duplicate helps nobody."
          flush
        >
          {!otherBugs ? (
            <div style={{ padding: 'var(--space-6)' }}>
              <Muted>The bugs service is unreachable. Refresh in a moment.</Muted>
            </div>
          ) : (
            <Table
              ariaLabel="Bugs reported by other testers"
              columns={otherBugColumns}
              rows={otherBugs}
              rowKey={(row) => row.id}
              rowHref={(row) => `/app/tester/bugs/${row.id}`}
              style={bareTableStyle}
              emptyState={
                <div style={{ padding: 'var(--space-6)' }}>
                  <Muted>Nobody else has filed against this build yet.</Muted>
                </div>
              }
            />
          )}
        </Panel>
      ) : null}

      {/* ── Announcements ────────────────────────────────────────────── */}
      {!isInvited && section === 'announcements' ? (
        <Panel
          title="Announcements"
          description="Notices for this project, plus anything the platform has posted to everyone."
        >
          {!announcements ? (
            <Muted>Announcements could not be loaded. Refresh in a moment.</Muted>
          ) : relevantAnnouncements.length === 0 ? (
            <Muted>Nothing has been posted for this project.</Muted>
          ) : (
            <ul style={{ ...listResetStyle, gap: 'var(--space-4)' }}>
              {relevantAnnouncements.map((row) => (
                <li
                  key={row.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-5)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-card)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 'var(--space-3)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 'var(--type-body-md-size)',
                        fontWeight: 'var(--fw-semibold)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {row.title}
                    </h3>
                    {/*
                      Three scopes reach this list, and which one a notice has
                      changes whether it is the tester's problem: their build,
                      the whole project, or the platform. Labelling only
                      "This project" would make a build-specific instruction
                      look like it applied to everyone on the project.
                    */}
                    <Badge
                      tone={row.buildId ? 'warning' : row.projectId ? 'info' : 'neutral'}
                      uppercase={false}
                    >
                      {row.buildId
                        ? (row.build?.name ?? 'Your build')
                        : row.projectId
                          ? 'This project'
                          : titleCase(row.audience)}
                    </Badge>
                  </div>
                  <Prose>{row.body}</Prose>
                  <Caption>{formatDateTime(row.publishedAt)}</Caption>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </DetailShell>
  )
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
    <p className="c4t-body-sm" style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}>
      {children}
    </p>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 'var(--type-caption-size)', color: 'var(--text-muted)' }}>{children}</span>
  )
}

/** Long free text written by the project team. Their line breaks are meaningful. */
function Prose({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'block', whiteSpace: 'pre-wrap', maxWidth: '75ch', lineHeight: 1.6 }}>
      {children}
    </span>
  )
}

function TokenList({ values, uppercase = true }: { values: readonly string[]; uppercase?: boolean }) {
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

/** A material points at either an uploaded file or an external link, never both. */
function MaterialTarget({ material }: { material: ProjectMaterial }) {
  if (material.file) {
    return <DownloadLink fileId={material.file.id} name={material.file.originalName} />
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

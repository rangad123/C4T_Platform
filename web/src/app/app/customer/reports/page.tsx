import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { loadList } from '@/lib/admin/list'
import { DetailShell } from '@/components/admin/DetailShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { BugBreakdownView, type BugBreakdown } from '@/components/admin/BugBreakdownView'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Input } from '@/components/ds/forms/Input'
import { formatDate } from '@/lib/admin/format'

const ROOT = { label: 'Customer', href: '/app/customer' }
const BASE = '/app/customer/reports'

/** The API caps `limit` at 100; see the note where the picker is loaded. */
const PROJECT_PICKER_LIMIT = 100

/**
 * `/app/customer/reports` — the reference product's Report page.
 *
 * The reference offers a project, then either a run of builds ("By Build",
 * with a start and an end) or a date range. Both already exist on the API as
 * `/v1/reports/by-build-range` and `/v1/reports/by-date`. "By project" is
 * added because the same module already serves it and it answers the most
 * common question — how is this project doing overall — without making
 * someone pick two builds first.
 *
 * Not a second report engine: every view calls `/v1/reports/*`, which are
 * themselves thin wrappers over the bug data the Bugs module already tracks.
 * Authorization is the API's — `report.generate` resolves through
 * `projectRelations`, so a customer passing another organisation's project id
 * gets a 404 rather than a report.
 */

const SECTIONS = [
  { value: 'by-project', label: 'By project', icon: 'briefcase' },
  { value: 'by-build', label: 'By build', icon: 'repeat' },
  { value: 'by-date', label: 'By date', icon: 'clock' },
] as const

interface ProjectOption {
  id: string
  reference: string
  title: string
}

interface BuildOption {
  id: string
  name: string
  status?: string
}

interface ByProjectReport {
  project: {
    id: string
    reference: string
    title: string
    status: string
    organisation: { id: string; name: string }
  }
  builds: BuildOption[]
  testerCount: number
  testCaseCount: number
  bugs: BugBreakdown
  testersByCountry: Record<string, number>
}

interface RangeReport {
  bugs: BugBreakdown
  builds?: BuildOption[]
}

const FORM_STYLE = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: 'var(--space-4)',
  alignItems: 'flex-end',
}

/**
 * Download the figures currently on screen.
 *
 * Rendered only once a report has actually loaded — a download button above
 * "choose a project first" offers a file that cannot exist.
 *
 * `prefetch={false}` is load-bearing, not tidiness: without it Next fetches
 * the target on hover, so merely passing the cursor over this would build a
 * report. See the prop's own note on `Button`.
 */
function DownloadCsv({ query }: { query: Record<string, string> }) {
  const href = `${BASE}/download?${new URLSearchParams(query).toString()}`
  return (
    <Button href={href} prefetch={false} variant="secondary" size="sm" iconLeft="download">
      Download CSV
    </Button>
  )
}

export default async function CustomerReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string
    projectId?: string
    startBuildId?: string
    endBuildId?: string
    startDate?: string
    endDate?: string
  }>
}) {
  await requireRole(['CUSTOMER'])
  const params = await searchParams
  const section = resolveSection(SECTIONS, params.section)

  /**
   * `GET /projects` is already organisation-scoped for a CUSTOMER caller, so
   * this picker can only list their own projects. There is no client-side
   * filtering here to get wrong.
   */
  const projectsResult = await loadList<ProjectOption>('projects', {
    page: 1,
    // 100 is the API's ceiling on `limit`. Asking for more is a 422, and
    // `loadList` swallows that into `{ error }` — which rendered as an empty
    // picker that looked like "you have no projects".
    limit: PROJECT_PICKER_LIMIT,
    query: { sort: 'title', order: 'asc' },
  })
  const projects = 'items' in projectsResult ? projectsResult.items : []
  /** A failed read is not the same as an empty account — say which. */
  const projectsFailed = 'error' in projectsResult
  const projectsTruncated = 'meta' in projectsResult && projectsResult.meta.total > projects.length

  const projectId = params.projectId ?? ''
  const projectOptions = [
    { value: '', label: 'Select a project' },
    ...projects.map((p) => ({ value: p.id, label: `${p.reference} · ${p.title}` })),
  ]

  /**
   * The build pickers need the chosen project's builds, and the by-project
   * report already returns them — so one read serves both the project view and
   * the build-range selectors rather than a second call for builds.
   */
  const projectReport = projectId
    ? await serverFetchOrNull<ByProjectReport>(`reports/by-project/${projectId}`)
    : null
  const buildOptions = (projectReport?.builds ?? []).map((b) => ({ value: b.id, label: b.name }))

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Reports' }]}
      eyebrow="Insights"
      title="Reports"
      subtitle="Bug distributions for a project, a run of builds, or a period."
      tabs={
        <SectionTabs basePath={BASE} tabs={SECTIONS} active={section} preserve={{ projectId }} />
      }
    >
      {projectsFailed ? (
        <EmptyState
          icon="alert-triangle"
          title="Reports could not be loaded"
          description="Your project list is unavailable right now. Refresh in a moment."
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="briefcase"
          title="No projects yet"
          description="Reports are built from the testing on your projects. Create one and the reports follow."
        />
      ) : (
        <>
          {projectsTruncated ? (
            <p
              style={{
                margin: 0,
                color: 'var(--text-muted)',
                fontSize: 'var(--type-body-sm-size)',
              }}
            >
              Showing your {projects.length} most recent projects. Older ones are not in this list
              yet.
            </p>
          ) : null}

          {section === 'by-project' ? (
            <Panel
              title="Project report"
              description="Everything reported on one project, across every build."
              actions={
                projectReport ? <DownloadCsv query={{ section: 'by-project', projectId }} /> : undefined
              }
            >
              <LiveGetForm action={BASE} style={FORM_STYLE}>
                <input type="hidden" name="section" value="by-project" />
                <Field label="Project" htmlFor="projectId" style={{ flex: '2 1 260px' }}>
                  <Select
                    id="projectId"
                    name="projectId"
                    defaultValue={projectId}
                    options={projectOptions}
                  />
                </Field>
                <LiveFormStatus />
              </LiveGetForm>

              {!projectId ? (
                <p style={{ marginTop: 'var(--space-5)', color: 'var(--text-secondary)' }}>
                  Choose a project to see its report.
                </p>
              ) : projectReport === null ? (
                <p style={{ marginTop: 'var(--space-5)', color: 'var(--text-secondary)' }}>
                  That report could not be loaded. Refresh in a moment.
                </p>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-6)',
                    marginTop: 'var(--space-5)',
                  }}
                >
                  <DescriptionList
                    items={[
                      {
                        label: 'Project',
                        value: `${projectReport.project.reference} · ${projectReport.project.title}`,
                      },
                      { label: 'Builds', value: String(projectReport.builds.length) },
                      { label: 'Testers', value: String(projectReport.testerCount) },
                      { label: 'Test cases', value: String(projectReport.testCaseCount) },
                    ]}
                  />
                  <BugBreakdownView bugs={projectReport.bugs} />
                </div>
              )}
            </Panel>
          ) : null}

          {section === 'by-build' ? (
            <BuildRangeReport
              projectId={projectId}
              projectOptions={projectOptions}
              buildOptions={buildOptions}
              startBuildId={params.startBuildId ?? ''}
              endBuildId={params.endBuildId ?? ''}
            />
          ) : null}

          {section === 'by-date' ? (
            <DateRangeReport startDate={params.startDate ?? ''} endDate={params.endDate ?? ''} />
          ) : null}
        </>
      )}
    </DetailShell>
  )
}

async function BuildRangeReport({
  projectId,
  projectOptions,
  buildOptions,
  startBuildId,
  endBuildId,
}: {
  projectId: string
  projectOptions: readonly { value: string; label: string }[]
  buildOptions: readonly { value: string; label: string }[]
  startBuildId: string
  endBuildId: string
}) {
  const ready = Boolean(projectId && startBuildId && endBuildId)
  const report = ready
    ? await serverFetchOrNull<RangeReport>('reports/by-build-range', {
        query: { projectId, startBuildId, endBuildId },
      })
    : null

  return (
    <Panel
      title="Build range report"
      description="Everything reported between two builds of one project, inclusive."
      actions={
        report ? (
          <DownloadCsv
            query={{ section: 'by-build', projectId, startBuildId, endBuildId }}
          />
        ) : undefined
      }
    >
      <LiveGetForm action={BASE} style={FORM_STYLE}>
        <input type="hidden" name="section" value="by-build" />
        <Field label="Project" htmlFor="projectId" style={{ flex: '2 1 240px' }}>
          <Select
            id="projectId"
            name="projectId"
            defaultValue={projectId}
            options={projectOptions}
          />
        </Field>
        {/*
          Both build pickers stay disabled until a project is chosen: their
          options come from that project, and offering them empty would read
          as though the project had no builds.
        */}
        <Field label="Start build" htmlFor="startBuildId" style={{ flex: '1 1 180px' }}>
          <Select
            id="startBuildId"
            name="startBuildId"
            defaultValue={startBuildId}
            disabled={!projectId}
            options={[
              { value: '', label: projectId ? 'Select a build' : 'Choose a project first' },
              ...buildOptions,
            ]}
          />
        </Field>
        <Field label="End build" htmlFor="endBuildId" style={{ flex: '1 1 180px' }}>
          <Select
            id="endBuildId"
            name="endBuildId"
            defaultValue={endBuildId}
            disabled={!projectId}
            options={[
              { value: '', label: projectId ? 'Select a build' : 'Choose a project first' },
              ...buildOptions,
            ]}
          />
        </Field>
        <LiveFormStatus />
      </LiveGetForm>

      <div style={{ marginTop: 'var(--space-5)' }}>
        {!ready ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Choose a project and both ends of the build range.
          </p>
        ) : report === null ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            That range could not be reported on. Check that both builds belong to the project you
            picked.
          </p>
        ) : (
          <BugBreakdownView bugs={report.bugs} />
        )}
      </div>
    </Panel>
  )
}

async function DateRangeReport({ startDate, endDate }: { startDate: string; endDate: string }) {
  const ready = Boolean(startDate && endDate)
  /**
   * The API validates the ordering too, but catching it here means the user
   * gets a sentence instead of a failed request — and no request is sent.
   * Both values are `YYYY-MM-DD`, so a string compare is a date compare.
   */
  const inverted = ready && startDate > endDate
  const report =
    ready && !inverted
      ? await serverFetchOrNull<RangeReport>('reports/by-date', { query: { startDate, endDate } })
      : null

  return (
    <Panel
      title="Period report"
      description="Everything reported across your projects between two dates."
      actions={
        report ? <DownloadCsv query={{ section: 'by-date', startDate, endDate }} /> : undefined
      }
    >
      <LiveGetForm action={BASE} style={FORM_STYLE}>
        <input type="hidden" name="section" value="by-date" />
        <Field label="From" htmlFor="startDate" style={{ flex: '1 1 180px' }}>
          <Input id="startDate" name="startDate" type="date" defaultValue={startDate} />
        </Field>
        <Field label="To" htmlFor="endDate" style={{ flex: '1 1 180px' }}>
          <Input id="endDate" name="endDate" type="date" defaultValue={endDate} />
        </Field>
        <LiveFormStatus />
      </LiveGetForm>

      <div style={{ marginTop: 'var(--space-5)' }}>
        {!ready ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Choose both ends of the period.
          </p>
        ) : inverted ? (
          <p role="alert" style={{ margin: 0, color: 'var(--status-error-fg)' }}>
            The start date is after the end date.
          </p>
        ) : report === null ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            That period could not be reported on. Refresh in a moment.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <p
              style={{
                margin: 0,
                color: 'var(--text-secondary)',
                fontSize: 'var(--type-body-sm-size)',
              }}
            >
              {formatDate(startDate)} – {formatDate(endDate)}
            </p>
            <BugBreakdownView bugs={report.bugs} />
          </div>
        )}
      </div>
    </Panel>
  )
}

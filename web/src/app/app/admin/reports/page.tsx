import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { loadList } from '@/lib/admin/list'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Input } from '@/components/ds/forms/Input'
import { Button } from '@/components/ds/core/Button'
import { BarChart } from '@/components/admin/charts/BarChart'
import { statusTone, severityTone } from '@/components/admin/StatusBadge'
import { formatDate, titleCase } from '@/lib/admin/format'

/**
 * `/app/admin/reports` — §15-21 of the platform UX brief.
 *
 * Every report here calls the API's `/v1/reports/*` routes, which are
 * themselves thin wrappers over the existing bug list/export and the Build
 * Summary endpoint — see the comment at the top of `reports.routes.ts` on
 * the API. This page adds no new report engine, only the pickers that scope
 * one of those existing capabilities to a project, a build, a date range or
 * a build range.
 *
 * By-build and by-build-range cascade (pick a project, THEN pick from its
 * builds) without any client JavaScript: each pick is its own GET form that
 * reloads the page with one more query parameter set, matching how every
 * other filter in this app works.
 */

const SECTIONS = [
  { value: 'by-project', label: 'By project', icon: 'briefcase' },
  { value: 'by-build', label: 'By build', icon: 'clock' },
  { value: 'by-date', label: 'By date', icon: 'filter' },
  { value: 'by-build-range', label: 'By build range', icon: 'repeat' },
] as const

interface BugBreakdown {
  total: number
  bySeverity: Record<string, number>
  byStatus: Record<string, number>
  byType: Record<string, number>
  byReproducibility: Record<string, number>
}

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
  project: { id: string; reference: string; title: string; status: string; organisation: { id: string; name: string } }
  builds: BuildOption[]
  testerCount: number
  testCaseCount: number
  bugs: BugBreakdown
}

function BugBreakdownView({ bugs, csvHref }: { bugs: BugBreakdown; csvHref: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          {bugs.total} bug{bugs.total === 1 ? '' : 's'} in this report.
        </p>
        <Button href={csvHref} prefetch={false} variant="secondary" size="sm" iconLeft="download">
          Download CSV
        </Button>
      </div>
      <BarChart
        title="By severity"
        segments={Object.entries(bugs.bySeverity).map(([label, value]) => ({
          label: titleCase(label),
          value,
          tone: severityTone(label),
        }))}
      />
      <BarChart
        title="By status"
        segments={Object.entries(bugs.byStatus).map(([label, value]) => ({
          label: titleCase(label),
          value,
          tone: statusTone(label),
        }))}
      />
    </div>
  )
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string
    projectId?: string
    buildId?: string
    startBuildId?: string
    endBuildId?: string
    startDate?: string
    endDate?: string
  }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const params = await searchParams
  const section = resolveSection(SECTIONS, params.section)

  const projectsResult = await loadList<ProjectOption>('projects', {
    page: 1,
    limit: 200,
    query: { sort: 'title', order: 'asc' },
  })
  const projects = 'items' in projectsResult ? projectsResult.items : []

  return (
    <main
      id="main"
      style={{ padding: 'var(--space-9)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
          Reports
        </p>
        <h1 className="c4t-display-md" style={{ margin: 0 }}>
          Reports
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}>
          Every report reuses the same bug data the Bugs module already tracks and the Build
          Summary already computes — scoped to a project, a build, a date range or a run of
          builds.
        </p>
      </header>

      <SectionTabs basePath="/app/admin/reports" tabs={SECTIONS} active={section} />

      {section === 'by-project' ? (
        <Panel title="Report by project" description="Every build's testers, test cases and bugs, rolled up to the project.">
          <LiveGetForm
            action="/app/admin/reports"
            style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', marginBottom: 'var(--space-6)' }}
          >
            <input type="hidden" name="section" value="by-project" />
            <Field label="Project" htmlFor="rpt-projectId">
              <Select
                id="rpt-projectId"
                name="projectId"
                defaultValue={params.projectId ?? ''}
                placeholder="Choose a project"
                options={projects.map((p) => ({ value: p.id, label: `${p.reference} — ${p.title}` }))}
              />
            </Field>
            <LiveFormStatus />
          </LiveGetForm>
          {params.projectId ? (
            <ByProject projectId={params.projectId} />
          ) : (
            <EmptyState icon="briefcase" title="Choose a project" description="Pick a project above to see its report." />
          )}
        </Panel>
      ) : null}

      {section === 'by-build' ? (
        <Panel title="Report by build" description="One test cycle's testers, test cases and bugs.">
          <LiveGetForm
            action="/app/admin/reports"
            style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', marginBottom: 'var(--space-6)' }}
          >
            <input type="hidden" name="section" value="by-build" />
            <Field label="Project" htmlFor="rpt-b-projectId">
              <Select
                id="rpt-b-projectId"
                name="projectId"
                defaultValue={params.projectId ?? ''}
                placeholder="Choose a project"
                options={projects.map((p) => ({ value: p.id, label: `${p.reference} — ${p.title}` }))}
              />
            </Field>
            <LiveFormStatus />
          </LiveGetForm>
          {!params.projectId ? (
            <EmptyState icon="briefcase" title="Choose a project" description="Pick a project above, then its build." />
          ) : (
            <ByBuildPicker projectId={params.projectId} buildId={params.buildId} />
          )}
        </Panel>
      ) : null}

      {section === 'by-date' ? (
        <Panel title="Report by date" description="Every bug reported across every project in the window, admin-wide.">
          <LiveGetForm
            action="/app/admin/reports"
            style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', marginBottom: 'var(--space-6)', flexWrap: 'wrap' }}
          >
            <input type="hidden" name="section" value="by-date" />
            <Field label="Start date" htmlFor="rpt-startDate">
              <Input id="rpt-startDate" name="startDate" type="date" defaultValue={params.startDate ?? ''} required />
            </Field>
            <Field label="End date" htmlFor="rpt-endDate">
              <Input id="rpt-endDate" name="endDate" type="date" defaultValue={params.endDate ?? ''} required />
            </Field>
            <LiveFormStatus />
          </LiveGetForm>
          {params.startDate && params.endDate ? (
            <ByDate startDate={params.startDate} endDate={params.endDate} />
          ) : (
            <EmptyState icon="filter" title="Pick a date range" description="Both a start and an end date are required." />
          )}
        </Panel>
      ) : null}

      {section === 'by-build-range' ? (
        <Panel title="Report by build range" description="Bugs across a run of builds on one project, from an earlier build to a later one.">
          <LiveGetForm
            action="/app/admin/reports"
            style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', marginBottom: 'var(--space-6)' }}
          >
            <input type="hidden" name="section" value="by-build-range" />
            <Field label="Project" htmlFor="rpt-r-projectId">
              <Select
                id="rpt-r-projectId"
                name="projectId"
                defaultValue={params.projectId ?? ''}
                placeholder="Choose a project"
                options={projects.map((p) => ({ value: p.id, label: `${p.reference} — ${p.title}` }))}
              />
            </Field>
            <LiveFormStatus />
          </LiveGetForm>
          {!params.projectId ? (
            <EmptyState icon="briefcase" title="Choose a project" description="Pick a project above, then its build range." />
          ) : (
            <ByBuildRangePicker
              projectId={params.projectId}
              startBuildId={params.startBuildId}
              endBuildId={params.endBuildId}
            />
          )}
        </Panel>
      ) : null}
    </main>
  )
}

async function ByProject({ projectId }: { projectId: string }) {
  const report = await serverFetchOrNull<ByProjectReport>(`reports/by-project/${projectId}`)
  if (!report) {
    return <EmptyState icon="alert-triangle" title="Could not load this report" description="The service is unreachable, or you do not have access to this project." />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div>
        <h3 className="c4t-heading-md" style={{ margin: 0 }}>
          {report.project.reference} — {report.project.title}
        </h3>
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-muted)' }}>
          {report.project.organisation.name} · {report.builds.length} build{report.builds.length === 1 ? '' : 's'} ·{' '}
          {report.testerCount} tester{report.testerCount === 1 ? '' : 's'} · {report.testCaseCount} test case
          {report.testCaseCount === 1 ? '' : 's'}
        </p>
      </div>
      <BugBreakdownView bugs={report.bugs} csvHref={`/app/admin/export/reports/by-project/${projectId}/export.csv`} />
    </div>
  )
}

async function ByBuildPicker({ projectId, buildId }: { projectId: string; buildId?: string }) {
  const builds = await serverFetchOrNull<BuildOption[]>(`projects/${projectId}/builds`)
  if (!builds) {
    return <EmptyState icon="alert-triangle" title="Could not load builds" description="Refresh in a moment." />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <LiveGetForm action="/app/admin/reports" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
        <input type="hidden" name="section" value="by-build" />
        <input type="hidden" name="projectId" value={projectId} />
        <Field label="Build" htmlFor="rpt-buildId">
          <Select
            id="rpt-buildId"
            name="buildId"
            defaultValue={buildId ?? ''}
            placeholder="Choose a build"
            options={builds.map((b) => ({ value: b.id, label: b.name }))}
          />
        </Field>
        <LiveFormStatus />
      </LiveGetForm>
      {buildId ? (
        <ByBuild buildId={buildId} />
      ) : (
        <EmptyState icon="clock" title="Choose a build" description="Pick a build above to see its report." />
      )}
    </div>
  )
}

interface ByBuildReport {
  testerCount: number
  bugCount: number
  bugsBySeverity: Record<string, number>
  bugsByStatus: Record<string, number>
  bugsByType: Record<string, number>
  bugsByReproducibility: Record<string, number>
  testCaseCount: number
  testCaseCompletion: number | null
}

async function ByBuild({ buildId }: { buildId: string }) {
  // The by-build "view" IS the Build Summary — see `testingService.buildSummary`,
  // reused directly (reports.routes.ts's comment: not a second report engine).
  const summary = await serverFetchOrNull<ByBuildReport>(`reports/by-build/${buildId}`)
  if (!summary) {
    return <EmptyState icon="alert-triangle" title="Could not load this report" description="Refresh in a moment." />
  }
  const bugs: BugBreakdown = {
    total: summary.bugCount,
    bySeverity: summary.bugsBySeverity,
    byStatus: summary.bugsByStatus,
    byType: summary.bugsByType,
    byReproducibility: summary.bugsByReproducibility,
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>
        {summary.testerCount} tester{summary.testerCount === 1 ? '' : 's'} · {summary.testCaseCount} test case
        {summary.testCaseCount === 1 ? '' : 's'}
        {summary.testCaseCompletion !== null ? ` · ${summary.testCaseCompletion}% complete` : ''}
      </p>
      <BugBreakdownView bugs={bugs} csvHref={`/app/admin/export/reports/by-build/${buildId}/export.csv`} />
    </div>
  )
}

async function ByDate({ startDate, endDate }: { startDate: string; endDate: string }) {
  const report = await serverFetchOrNull<{ bugs: BugBreakdown; byProject: { project: ProjectOption | null; bugCount: number }[] }>(
    `reports/by-date?startDate=${startDate}&endDate=${endDate}`,
  )
  if (!report) {
    return <EmptyState icon="alert-triangle" title="Could not load this report" description="Only the platform side can report across every project." />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>
        {formatDate(startDate)} to {formatDate(endDate)}
      </p>
      <BugBreakdownView
        bugs={report.bugs}
        csvHref={`/app/admin/export/reports/by-date/export.csv?startDate=${startDate}&endDate=${endDate}`}
      />
      {report.byProject.length > 0 ? (
        <div>
          <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-3)' }}>
            By project
          </p>
          <BarChart
            title="Bugs per project"
            segments={report.byProject
              .filter((p) => p.project)
              .map((p) => ({ label: p.project!.reference, value: p.bugCount, tone: 'neutral' as const }))}
          />
        </div>
      ) : null}
    </div>
  )
}

async function ByBuildRangePicker({
  projectId,
  startBuildId,
  endBuildId,
}: {
  projectId: string
  startBuildId?: string
  endBuildId?: string
}) {
  const builds = await serverFetchOrNull<BuildOption[]>(`projects/${projectId}/builds`)
  if (!builds) {
    return <EmptyState icon="alert-triangle" title="Could not load builds" description="Refresh in a moment." />
  }
  const options = builds.map((b) => ({ value: b.id, label: b.name }))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <LiveGetForm
        action="/app/admin/reports"
        style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}
      >
        <input type="hidden" name="section" value="by-build-range" />
        <input type="hidden" name="projectId" value={projectId} />
        <Field label="Start build" htmlFor="rpt-startBuildId">
          <Select id="rpt-startBuildId" name="startBuildId" defaultValue={startBuildId ?? ''} placeholder="Choose a build" options={options} />
        </Field>
        <Field label="End build" htmlFor="rpt-endBuildId">
          <Select id="rpt-endBuildId" name="endBuildId" defaultValue={endBuildId ?? ''} placeholder="Choose a build" options={options} />
        </Field>
        <LiveFormStatus />
      </LiveGetForm>
      {startBuildId && endBuildId ? (
        <ByBuildRange projectId={projectId} startBuildId={startBuildId} endBuildId={endBuildId} />
      ) : (
        <EmptyState icon="repeat" title="Choose both builds" description="A start and an end build are both required." />
      )}
    </div>
  )
}

async function ByBuildRange({
  projectId,
  startBuildId,
  endBuildId,
}: {
  projectId: string
  startBuildId: string
  endBuildId: string
}) {
  const report = await serverFetchOrNull<{ builds: BuildOption[]; bugs: BugBreakdown }>(
    `reports/by-build-range?projectId=${projectId}&startBuildId=${startBuildId}&endBuildId=${endBuildId}`,
  )
  if (!report) {
    return <EmptyState icon="alert-triangle" title="Could not load this report" description="Both builds must belong to the selected project." />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>
        {report.builds.map((b) => b.name).join(' → ')}
      </p>
      <BugBreakdownView
        bugs={report.bugs}
        csvHref={`/app/admin/export/reports/by-build-range/export.csv?projectId=${projectId}&startBuildId=${startBuildId}&endBuildId=${endBuildId}`}
      />
    </div>
  )
}

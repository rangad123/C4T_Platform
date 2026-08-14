import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { StatusBadge, RoleBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Button } from '@/components/ds/core/Button'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { requirePermission } from '@/lib/auth/session'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { assignProjectAction, unassignProjectAction } from '@/lib/admin/manager-actions'
import { personName, titleCase } from '@/lib/admin/format'

/**
 * `/app/admin/managers/[id]` — manager profile and the projects they oversee.
 *
 * The manager's own row comes from the users endpoint (the /v1/managers
 * list is for browsing; per-record lookups should re-use the richer user
 * record). The projects they manage come from the dedicated managers
 * endpoint, which is the only place this join lives.
 *
 * Assigning a project uses a single assign-form below the project list
 * (instead of a row-per-row select) because the API takes a managerId +
 * projectId pair and that is what the action forwards. A row-per-row
 * select would have to know the manager id in each row, which is just a
 * constant hidden input.
 */

interface ManagerRecord {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  role: string
  status: string
}

interface ManagerProjectEnvelope {
  data: ManagerProject[]
}

interface ManagerProject {
  project: {
    id: string
    reference: string
    title: string
    status: string
    priority: string
    organisation: { id: string; name: string } | null
    _count: { bugs: number; assignments: number }
  }
}

interface ProjectOption {
  id: string
  reference: string
  title: string
  status: string
}

interface ProjectListEnvelope {
  data: ProjectOption[]
}

export default async function ManagerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('manager.read')
  const { id } = await params

  /**
   * Fetch the manager up front. 404 here means the URL is wrong — the
   * notFound() response is the correct one (it renders not-found.tsx, not
   * the error boundary).
   */
  let manager: ManagerRecord
  try {
    manager = await serverFetch<ManagerRecord>(`users/${id}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  /**
   * The two additional reads are best-effort: a missing project list still
   * renders a useful page. Failures are surfaced inline rather than via an
   * overlay so the reader keeps the manager record.
   */
  const [projectsResult, candidatesResult] = await Promise.all([
    serverFetchOrNull<ManagerProjectEnvelope>(`managers/${id}/projects`),
    serverFetchOrNull<ProjectListEnvelope>('projects', {
      query: { limit: 200 },
    }),
  ])

  const projects = projectsResult?.data ?? []
  const projectsFailed = projectsResult === null
  const assignedIds = new Set(projects.map((p) => p.project.id))
  const candidates = (candidatesResult?.data ?? []).filter((p) => !assignedIds.has(p.id))

  const columns: readonly TableColumn<ManagerProject>[] = [
    {
      key: 'reference',
      header: 'Project',
      render: (row) => row.project.title,
      renderSecondary: (row) => row.project.reference,
    },
    {
      key: 'org',
      header: 'Organisation',
      render: (row) => row.project.organisation?.name ?? '—',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={row.project.status} />,
    },
    {
      key: 'priority',
      header: 'Priority',
      render: (row) => titleCase(row.project.priority),
    },
    {
      key: 'bugs',
      header: 'Bugs',
      align: 'right',
      render: (row) => row.project._count.bugs,
    },
    {
      key: 'unassign',
      header: '',
      align: 'right',
      render: (row) => (
        <form action={unassignProjectAction}>
          <input type="hidden" name="managerId" value={id} />
          <input type="hidden" name="projectId" value={row.project.id} />
          <Button type="submit" variant="ghost" iconLeft="x" size="sm">
            Unassign
          </Button>
        </form>
      ),
    },
  ]

  const candidatesFailed = candidatesResult === null
  const candidateOptions = candidates.slice(0, 50).map((p) => ({
    value: p.id,
    label: `${p.reference} — ${p.title}`,
  }))

  return (
    <DetailShell
      crumbs={[
        { label: 'Managers', href: '/app/admin/managers' },
        { label: personName(manager) || manager.email },
      ]}
      eyebrow="Accounts"
      title={personName(manager) || manager.email}
      subtitle={manager.email}
      badges={
        <>
          <RoleBadge role={manager.role} />
          <StatusBadge status={manager.status} />
        </>
      }
    >
      <Panel
        title="Projects overseen"
        description={
          projectsFailed
            ? "The project list could not be loaded. The assignments still exist in the database — try refresh."
            : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}. Unassigning removes the manager from the project without affecting the project itself.`
        }
      >
        {projects.length === 0 ? (
          <EmptyState
            icon="briefcase"
            title="No projects yet"
            description="Assign a project below to start this manager overseeing it."
          />
        ) : (
          <Table<ManagerProject>
            ariaLabel="Projects overseen"
            columns={columns}
            rows={projects}
            rowKey={(row) => row.project.id}
          />
        )}
      </Panel>

      <Panel
        title="Assign a project"
        description="Pick a project to add this manager to it. The list is filtered to projects they are not already on."
      >
        {candidatesFailed ? (
          <EmptyState
            icon="alert-triangle"
            title="Project list unavailable"
            description="The project search is unreachable. Try again in a moment."
          />
        ) : candidates.length === 0 ? (
          <EmptyState
            icon="briefcase"
            title="No more projects to assign"
            description="This manager is already overseeing every project on the platform. Create a new project to assign it."
            action={
              <Link href="/app/admin/projects/new">
                <Button variant="secondary" iconLeft="plus">
                  New project
                </Button>
              </Link>
            }
          />
        ) : (
          <form action={assignProjectAction} style={formStyle}>
            <Field
              label="Project"
              htmlFor="projectId"
              hint={`Showing the first ${Math.min(50, candidates.length)} of ${candidates.length} eligible projects. Use the Projects page to find more.`}
            >
              <Select
                id="projectId"
                name="projectId"
                defaultValue=""
                placeholder="Pick a project"
                options={candidateOptions}
              />
            </Field>
            <input type="hidden" name="managerId" value={id} />
            <div>
              <Button type="submit" variant="primary" iconLeft="check">
                Assign
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </DetailShell>
  )
}

const formStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-5)',
  maxWidth: 540,
}

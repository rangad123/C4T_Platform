import { notFound, redirect } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Button } from '@/components/ds/core/Button'
import { AssignWorkspace } from '@/components/admin/assign/AssignWorkspace'
import type { Candidate, CandidateMeta } from '@/components/admin/assign/types'
import { serverFetch, serverFetchPage } from '@/lib/api/server'
import { testerFilterOptions, type CatalogPayload } from '@/lib/admin/tester-filters'
import { requirePermission } from '@/lib/auth/session'
import { ApiError } from '@/lib/api/types'

/**
 * `/app/admin/projects/[id]/assign` — the assignment workspace.
 *
 * A route of its own rather than another panel on the project page. Choosing
 * who tests a build is a task with its own steps (find, review, configure,
 * confirm), and it was previously a checkbox grid wedged under the roster
 * with nowhere to put any of that.
 *
 * The server does three things and then gets out of the way: authorise,
 * establish which project and build this is, and render the first page of
 * results so the workspace opens with rows rather than a spinner. Everything
 * after that — searching, filtering, paging, selecting — happens client-side,
 * because selection has to survive all of it. See `AssignWorkspace`.
 */

interface ProjectContext {
  id: string
  reference: string
  title: string
  activeBuildId: string
  builds: readonly { id: string; name: string }[]
  capabilities: { canAssignTesters: boolean }
}

interface BuildDetail {
  id: string
  name: string
  targetDevices: readonly string[]
  targetBrowsers: readonly string[]
  targetOperatingSystems: readonly string[]
}

interface TemplateRow {
  id: string
  name: string
  subject: string | null
  body: string
}

export default async function AssignTestersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ buildId?: string }>
}) {
  await requirePermission('project.assign')

  const { id } = await params
  const { buildId: requestedBuildId } = await searchParams

  let project: ProjectContext
  try {
    project = await serverFetch<ProjectContext>(`projects/${id}`, {
      query: requestedBuildId ? { buildId: requestedBuildId } : undefined,
    })
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound()
    throw caught
  }

  /**
   * The build comes from the project read, not from the query string as
   * given: the API resolves an absent or unknown `buildId` to the project's
   * default and reports what it actually used. Trusting the raw parameter is
   * how testers end up assigned to a build nobody chose.
   */
  const buildId = project.activeBuildId
  const build = project.builds.find((b) => b.id === buildId)

  /**
   * `capabilities` is the project-scoped answer, where `requirePermission`
   * above is only the role-scoped one. Both are checked, and the API checks
   * again on the assign itself.
   */
  if (!project.capabilities.canAssignTesters) {
    redirect(`/app/admin/projects/${id}?section=testers`)
  }

  const [candidates, catalog, buildDetail, templates] = await Promise.all([
    serverFetchPage<Candidate>('testers/assignment-candidates', {
      query: {
        buildId,
        status: 'VERIFIED',
        limit: 25,
        page: 1,
        sort: 'ratingAverage',
        order: 'desc',
      },
    }).catch(() => ({ data: [] as Candidate[], meta: { total: 0, page: 1, limit: 25 } })),
    serverFetch<CatalogPayload>('catalog').catch(() => null),
    /**
     * The build's own targets, for the compatibility warnings. Best-effort:
     * without them every tester simply passes, which is the same behaviour
     * the platform had before this screen existed.
     */
    serverFetch<BuildDetail>(`projects/${id}/builds/${buildId}`).catch(() => null),
    /**
     * §23 message templates. Requires `communication.read`, which an admin
     * assigning testers may not hold — so a failure means "no templates
     * offered", never a broken page.
     */
    serverFetch<TemplateRow[]>('communication/templates').catch(() => [] as TemplateRow[]),
  ])

  const options = testerFilterOptions(catalog)

  const projectLabel = `${project.reference} · ${project.title}`
  const detailHref = `/app/admin/projects/${project.id}?section=testers&buildId=${buildId}`

  return (
    <DetailShell
      root={{ label: 'Admin', href: '/app/admin' }}
      crumbs={[
        { label: 'Projects', href: '/app/admin/projects' },
        { label: project.reference, href: detailHref },
        { label: 'Assign testers' },
      ]}
      eyebrow="Delivery"
      title="Invite testers"
      subtitle={`${projectLabel} · ${build?.name ?? 'default build'}`}
    >
      {!build ? (
        <EmptyState
          icon="alert-triangle"
          title="This project has no build to assign against"
          description="Create a build first — testers are invited onto a build, not onto the project."
          action={
            <Button href={detailHref} variant="primary">
              Back to the project
            </Button>
          }
        />
      ) : (
        <AssignWorkspace
          projectId={project.id}
          buildId={buildId}
          buildName={build.name}
          projectLabel={projectLabel}
          options={options}
          targets={{
            devices: buildDetail?.targetDevices ?? [],
            browsers: buildDetail?.targetBrowsers ?? [],
            operatingSystems: buildDetail?.targetOperatingSystems ?? [],
          }}
          templates={Array.isArray(templates) ? templates : []}
          initialCandidates={candidates.data}
          initialMeta={candidates.meta as CandidateMeta}
        />
      )}
    </DetailShell>
  )
}

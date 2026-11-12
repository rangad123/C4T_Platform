import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { BuildSwitcher } from '@/components/admin/BuildSwitcher'
import { AutomationPanels, type AutomationData } from '@/components/admin/AutomationPanels'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'

export const metadata: Metadata = { title: 'Automation' }

/**
 * `/app/admin/projects/[id]/automation` — automation modules and run reports for one
 * build. The API decides whether the forms show (`canManage`).
 */
export default async function AutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ buildId?: string; notice?: string; error?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const { id } = await params
  const query = await searchParams

  let project: {
    id: string
    reference: string
    title: string
    builds: readonly { id: string; name: string }[]
  }
  let data: AutomationData
  try {
    ;[project, data] = await Promise.all([
      serverFetch<typeof project>(`projects/${id}`, {
        query: query.buildId ? { buildId: query.buildId } : undefined,
      }),
      serverFetch<AutomationData>(`automation/projects/${id}`, {
        query: query.buildId ? { buildId: query.buildId } : undefined,
      }),
    ])
  } catch (caught) {
    if (caught instanceof ApiError && (caught.status === 404 || caught.status === 400)) notFound()
    throw caught
  }

  const path = `/app/admin/projects/${project.id}/automation`
  const build = project.builds.find((b) => b.id === data.buildId)

  return (
    <DetailShell
      root={{ label: 'Admin', href: '/app/admin' }}
      crumbs={[
        { label: 'Projects', href: '/app/admin/projects' },
        {
          label: project.reference,
          href: `/app/admin/projects/${project.id}?buildId=${data.buildId}`,
        },
        { label: 'Automation' },
      ]}
      eyebrow="Delivery"
      title="Automation"
      subtitle={`${project.reference} · ${project.title} · ${build?.name ?? 'build'}`}
      tabs={
        project.builds.length > 1 ? (
          <BuildSwitcher basePath={path} builds={project.builds} activeBuildId={data.buildId} />
        ) : undefined
      }
    >
      <AutomationPanels
        data={data}
        projectId={project.id}
        returnTo={path}
        uploadEndpoint="/app/admin/upload"
        downloadBase="/app/admin/download"
        notice={query.notice}
        error={query.error}
      />
    </DetailShell>
  )
}

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
 * `/app/tester/projects/[id]/automation` — automation modules and run reports for one
 * build. Read only: testers on the project see what the automation covers.
 */
export default async function AutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ buildId?: string; notice?: string; error?: string }>
}) {
  await requireRole(['TESTER'])
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

  const path = `/app/tester/projects/${project.id}/automation`
  const build = project.builds.find((b) => b.id === data.buildId)

  return (
    <DetailShell
      root={{ label: 'Tester', href: '/app/tester' }}
      crumbs={[
        { label: 'Projects', href: '/app/tester/projects' },
        {
          label: project.reference,
          href: `/app/tester/projects/${project.id}?buildId=${data.buildId}`,
        },
        { label: 'Automation' },
      ]}
      eyebrow="Work"
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
        downloadBase="/app/tester/download"
        notice={query.notice}
        error={query.error}
      />
    </DetailShell>
  )
}

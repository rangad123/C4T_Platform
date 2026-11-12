import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import {
  BugTrackerConnectionPanel,
  BugTrackerNotices,
  type BugTrackerConnection,
} from '@/components/bug-tracker/BugTracker'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'

/**
 * `/app/admin/organisations/[id]/bug-tracker` — set up or fix an
 * organisation's Jira connection on their behalf.
 */
export default async function AdminBugTrackerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ notice?: string; error?: string }>
}) {
  await requirePermission('organisation.write')
  const { id } = await params
  const { notice, error } = await searchParams

  let organisation: { id: string; name: string }
  let connection: BugTrackerConnection | null
  try {
    ;[organisation, connection] = await Promise.all([
      serverFetch<{ id: string; name: string }>(`organisations/${id}`),
      serverFetch<BugTrackerConnection | null>(`bug-tracker/organisations/${id}`),
    ])
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound()
    throw e
  }
  const path = `/app/admin/organisations/${id}/bug-tracker`

  return (
    <DetailShell
      crumbs={[
        { label: 'Organisations', href: '/app/admin/organisations' },
        { label: organisation.name, href: `/app/admin/organisations/${id}` },
        { label: 'Bug tracker' },
      ]}
      eyebrow="Integrations"
      title={`${organisation.name} bug tracker`}
      subtitle="The Jira site this organisation's bugs are exported to."
    >
      <BugTrackerNotices notice={notice} error={error} />
      <BugTrackerConnectionPanel orgId={id} back={path} connection={connection} />
    </DetailShell>
  )
}

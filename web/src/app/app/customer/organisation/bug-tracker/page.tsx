import { DetailShell } from '@/components/admin/DetailShell'
import {
  BugTrackerConnectionPanel,
  BugTrackerNotices,
  type BugTrackerConnection,
} from '@/components/bug-tracker/BugTracker'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'

const ROOT = { label: 'Customer', href: '/app/customer' }
const PATH = '/app/customer/organisation/bug-tracker'

/**
 * `/app/customer/organisation/bug-tracker` — the organisation's Jira
 * connection. Owners manage it; other members are told who can.
 */
export default async function CustomerBugTrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>
}) {
  await requireRole(['CUSTOMER'])
  const { notice, error } = await searchParams
  const mine =
    await serverFetchOrNull<readonly { id: string; name: string; orgRole: string }[]>(
      'organisations/mine',
    )
  const organisation = mine?.[0]
  const isOwner = organisation?.orgRole === 'OWNER'
  const connection =
    organisation && isOwner
      ? await serverFetch<BugTrackerConnection | null>(
          `bug-tracker/organisations/${organisation.id}`,
        )
      : null

  return (
    <DetailShell
      root={ROOT}
      crumbs={[
        { label: 'Organisation', href: '/app/customer/organisation' },
        { label: 'Bug tracker' },
      ]}
      eyebrow="Account"
      title="Bug tracker"
      subtitle="Send bugs from Crowd4Test to your own Jira project."
    >
      <BugTrackerNotices notice={notice} error={error} />
      {!organisation ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          You are not attached to an organisation yet.
        </p>
      ) : isOwner ? (
        <BugTrackerConnectionPanel orgId={organisation.id} back={PATH} connection={connection} />
      ) : (
        <p style={{ color: 'var(--text-secondary)' }}>
          Only an owner of {organisation.name} can connect Jira. Once it is connected, you can
          export bugs from each bug page.
        </p>
      )}
    </DetailShell>
  )
}

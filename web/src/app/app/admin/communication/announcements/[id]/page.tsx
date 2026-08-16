import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Badge } from '@/components/ds/core/Badge'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'
import { formatDateTime, personName, titleCase } from '@/lib/admin/format'

interface AnnouncementDetail {
  id: string
  title: string
  body: string
  audience: string
  publishedAt: string | null
  expiresAt: string | null
  author: { id: string; firstName: string | null; lastName: string | null }
}

/**
 * `/app/admin/communication/announcements/[id]` — one announcement.
 *
 * Plain read view: title, audience badge, body, schedule, author. The
 * body renders verbatim — announcements are Admin-authored, so we trust
 * the source. If untrusted authors are ever allowed, swap in a
 * sanitiser before `dangerouslySetInnerHTML`.
 */
export default async function AnnouncementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  await requirePermission('announcement.write')

  let announcement: AnnouncementDetail
  try {
    announcement = await serverFetch<AnnouncementDetail>(
      `communication/announcements/${id}`,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const status = announcement.publishedAt
    ? announcement.expiresAt && new Date(announcement.expiresAt) < new Date()
      ? 'Expired'
      : 'Published'
    : 'Draft'

  return (
    <DetailShell
      crumbs={[
        { label: 'Communication', href: '/app/admin/communication' },
        { label: announcement.title },
      ]}
      eyebrow="Operations"
      title={announcement.title}
      badges={
        <Badge tone={audienceTone(announcement.audience)} uppercase={false}>
          {titleCase(announcement.audience)}
        </Badge>
      }
    >
      <Panel
        title="Body"
        description="The text as it was sent to the audience."
      >
        <div
          style={{
            whiteSpace: 'pre-wrap',
            color: 'var(--text-primary)',
            fontSize: 'var(--type-body-md-size)',
            lineHeight: 1.6,
          }}
        >
          {announcement.body}
        </div>
      </Panel>

      <Panel title="Schedule">
        <DescriptionList
          items={[
            { label: 'Status', value: status },
            {
              label: 'Published',
              value: announcement.publishedAt ? formatDateTime(announcement.publishedAt) : '—',
            },
            {
              label: 'Expires',
              value: announcement.expiresAt ? formatDateTime(announcement.expiresAt) : 'Never',
            },
            { label: 'Author', value: personName(announcement.author) },
          ]}
        />
      </Panel>
    </DetailShell>
  )
}

function audienceTone(audience: string): 'brand' | 'info' | 'accent' | 'neutral' {
  if (audience === 'ALL') return 'brand'
  if (audience === 'CUSTOMERS') return 'info'
  if (audience === 'TESTERS') return 'accent'
  return 'neutral'
}

import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { AdminListPage } from '@/components/admin/AdminListPage'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { loadList, parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { formatDate, personName, titleCase } from '@/lib/admin/format'
import type { TableColumn } from '@/components/ds/admin/Table'

const PAGE_SIZE = 25
const BASE = '/app/admin/communication'

interface AnnouncementRow {
  id: string
  title: string
  body: string
  audience: string
  projectId: string | null
  project: { id: string; reference: string; title: string } | null
  publishedAt: string | null
  expiresAt: string | null
  author: { id: string; firstName: string | null; lastName: string | null } | null
}

/** Audience is not a status, so it gets its own tone map rather than reusing one. */
const AUDIENCE_TONE: Record<string, 'neutral' | 'brand' | 'info' | 'accent'> = {
  ALL: 'brand',
  CUSTOMERS: 'info',
  TESTERS: 'accent',
  ADMINS: 'neutral',
}

/**
 * `/app/admin/communication` — platform announcements.
 *
 * The API's communication module covers two things: announcements (one author,
 * many readers) and message threads (many participants, scoped by membership).
 * This page is the announcements half, because that is the one an admin *sends*
 * — threads are a reply surface and want a different layout, so they will get
 * their own page rather than a second table here.
 *
 * A row with no `publishedAt` is a draft. It shows as "Draft" rather than as an
 * empty date cell, because an unpublished announcement looks identical to a
 * published one otherwise, and sending is the irreversible bit.
 */
export default async function CommunicationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const page = parsePage(params.page)

  // The announcements endpoint takes pagination only — no filter params, so
  // passing any would earn a 422 from the strict query schema.
  const result = await loadList<AnnouncementRow>('communication/announcements', {
    page,
    limit: PAGE_SIZE,
  })

  const columns: readonly TableColumn<AnnouncementRow>[] = [
    {
      key: 'title',
      header: 'Announcement',
      render: (row) => row.title,
      renderSecondary: (row) =>
        row.body.length > 110 ? `${row.body.slice(0, 110).trimEnd()}…` : row.body,
    },
    {
      key: 'audience',
      header: 'Audience',
      render: (row) => (
        <Badge tone={AUDIENCE_TONE[row.audience] ?? 'neutral'} uppercase={false}>
          {titleCase(row.audience)}
        </Badge>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      // Links to the project, i.e. a different record than the row link.
      interactive: true,
      render: (row) =>
        row.project ? (
          <Link href={`/app/admin/projects/${row.project.id}`}>{row.project.reference}</Link>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>Platform-wide</span>
        ),
    },
    {
      key: 'author',
      header: 'Author',
      render: (row) => personName(row.author),
    },
    {
      key: 'published',
      header: 'Published',
      align: 'right',
      render: (row) =>
        row.publishedAt ? (
          formatDate(row.publishedAt)
        ) : (
          <Badge tone="warning" uppercase={false}>
            Draft
          </Badge>
        ),
    },
    {
      key: 'expires',
      header: 'Expires',
      align: 'right',
      render: (row) => formatDate(row.expiresAt),
    },
  ]

  return (
    <AdminListPage
      eyebrow="Operations"
      title="Communication"
      description="Announcements published to the platform, and who each one reaches. An announcement with no publish date is still a draft."
      crumbs={[{ label: 'Communication' }]}
      result={result}
      columns={columns}
      rowKey={(row) => row.id}
      rowHref={(row) => `/app/admin/communication/announcements/${row.id}`}
      hrefFor={pageHrefBuilder(BASE, {})}
      permission="announcement.write"
      emptyIcon="message-square"
      emptyTitle="No announcements yet"
      emptyDescription="Publish one to tell customers or testers about a release, a maintenance window, or a policy change."
      toolbar={
        /* Communication covers two surfaces: announcements (one author, many
           readers) and threads (a conversation with participants). This page is
           the announcements half; threads get their own list because the useful
           columns are completely different. */
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Button href="/app/admin/communication/announcements/new" variant="primary" iconLeft="plus">
              Compose announcement
            </Button>
          <Button href="/app/admin/communication/broadcast" variant="secondary" iconLeft="users">
              Message a group of testers
            </Button>
          <Button href="/app/admin/communication/threads" variant="secondary" iconLeft="message-square">
              Open message threads
            </Button>
          <Button href="/app/admin/communication/templates" variant="secondary" iconLeft="file-text">
              Manage templates
            </Button>
        </div>
      }
    />
  )
}

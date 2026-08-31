import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/session'
import { serverFetch, serverFetchOrNull } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { Avatar } from '@/components/admin/Avatar'
import { CountryLabel } from '@/components/admin/CountryFlag'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Badge } from '@/components/ds/core/Badge'
import { formatDate } from '@/lib/admin/format'

const ROOT = { label: 'Customer', href: '/app/customer' }
const LIST_PATH = '/app/customer/crowdtesters'

/** Same shape `discoverTesters` returns, one row instead of a page. */
interface TesterProfileDetail {
  id: string
  displayName: string
  avatarFileId: string | null
  headline: string | null
  bio: string | null
  profession: string | null
  city: string | null
  countryCode: string | null
  ratingAverage: string | null
  ratingCount: number
  bugsAcceptedCount: number
  projectsCompletedCount: number
  experienceYears: number | null
  skills: readonly { id: string; name: string; slug: string }[]
  platforms: readonly string[]
}

/**
 * One engagement of this tester ON THE VIEWER'S OWN PROJECTS.
 *
 * The API scopes this to the caller's organisation, so it can never name
 * another customer's work — see `getTesterEngagementsForOrganisation`.
 */
interface TesterEngagement {
  status: string
  invitedAt: string
  respondedAt: string | null
  completedAt: string | null
  project: { id: string; reference: string; title: string }
  build: { id: string; name: string; testType: string | null } | null
  bugsReported: number
}

function formatRating(raw: string | null): string | null {
  if (raw == null) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value.toFixed(1) : null
}

function Muted({ children }: { children: string }) {
  return (
    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
      {children}
    </span>
  )
}

/**
 * `/app/customer/crowdtesters/[id]` — one tester's public profile, reached by
 * clicking their card on the crowd browser. Read-only: a customer views this
 * to judge capability, there is nothing here to edit.
 */
export default async function CrowdtesterProfilePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireRole(['CUSTOMER'])
  const { id } = await params

  let tester: TesterProfileDetail | null = null
  try {
    tester = await serverFetch<TesterProfileDetail>(`testers/discover/${id}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }

  // Optional: a profile is still worth showing if the history fails to load.
  const engagements =
    (await serverFetchOrNull<readonly TesterEngagement[]>(`testers/discover/${id}/engagements`)) ??
    []

  const rating = formatRating(tester.ratingAverage)

  const engagementColumns: readonly TableColumn<TesterEngagement>[] = [
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project.title,
      renderSecondary: (row) =>
        row.build ? `${row.project.reference} · ${row.build.name}` : row.project.reference,
    },
    {
      key: 'testType',
      header: 'Testing',
      render: (row) => row.build?.testType ?? '—',
    },
    {
      key: 'status',
      header: 'Standing',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'bugs',
      header: 'Bugs filed',
      align: 'right',
      render: (row) => String(row.bugsReported),
    },
    {
      key: 'dates',
      header: 'Invited',
      align: 'right',
      render: (row) => formatDate(row.invitedAt),
      renderSecondary: (row) =>
        row.completedAt
          ? `Finished ${formatDate(row.completedAt)}`
          : row.respondedAt
            ? `Responded ${formatDate(row.respondedAt)}`
            : undefined,
    },
  ]

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Crowdtesters', href: LIST_PATH }, { label: tester.displayName }]}
      eyebrow="Delivery"
      title={tester.displayName}
      subtitle={tester.profession ?? tester.headline ?? undefined}
    >
      <Panel title="Overview">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            marginBottom: 'var(--space-5)',
          }}
        >
          <Avatar name={tester.displayName} fileId={tester.avatarFileId} size="lg" />
          <div>
            <div className="c4t-heading-md">{tester.displayName}</div>
            {tester.headline ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{tester.headline}</p>
            ) : null}
          </div>
        </div>
        <DescriptionList
          items={[
            { label: 'Profession', value: tester.profession ?? '—' },
            { label: 'City', value: tester.city ?? '—' },
            {
              label: 'Country',
              value: tester.countryCode ? (
                <CountryLabel countryCode={tester.countryCode} size={14} />
              ) : (
                '—'
              ),
            },
            {
              label: 'Rating',
              value: rating ? `${rating} (${tester.ratingCount})` : 'Not yet rated',
            },
            {
              label: 'Experience',
              value: tester.experienceYears != null ? `${tester.experienceYears} years` : '—',
            },
            { label: 'Bugs accepted', value: String(tester.bugsAcceptedCount) },
            { label: 'Projects completed', value: String(tester.projectsCompletedCount) },
          ]}
        />
      </Panel>

      {/*
       * Work history, scoped to this customer's own projects.
       *
       * Deliberately not this tester's full platform history: a project title
       * names a client and what they were building, so listing everything
       * would leak one customer's roadmap to another just because they hired
       * the same tester. The question worth answering — "have they worked
       * with US, and how did it go" — needs no one else's data.
       */}
      <Panel
        title="Work history"
        description="What this tester has done on your projects."
        flush={engagements.length > 0}
      >
        {engagements.length === 0 ? (
          <Muted>This tester has not worked on any of your projects yet.</Muted>
        ) : (
          <Table
            columns={engagementColumns}
            rows={[...engagements]}
            rowKey={(row) => `${row.project.id}:${row.build?.id ?? 'none'}`}
            rowHref={(row) => `/app/customer/projects/${row.project.id}`}
          />
        )}
      </Panel>

      {tester.bio ? (
        <Panel title="About">
          <p style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
            {tester.bio}
          </p>
        </Panel>
      ) : null}

      <Panel title="Skills">
        {tester.skills.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {tester.skills.map((skill) => (
              <Badge key={skill.id} tone="neutral" uppercase={false}>
                {skill.name}
              </Badge>
            ))}
          </div>
        ) : (
          <Muted>No skills listed.</Muted>
        )}
      </Panel>

      <Panel title="Devices">
        {tester.platforms.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {tester.platforms.map((platform) => (
              <Badge key={platform} tone="neutral" uppercase={false}>
                {platform}
              </Badge>
            ))}
          </div>
        ) : (
          <Muted>No devices listed.</Muted>
        )}
      </Panel>
    </DetailShell>
  )
}

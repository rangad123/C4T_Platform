import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/session'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { Avatar } from '@/components/admin/Avatar'
import { CountryLabel } from '@/components/admin/CountryFlag'
import { Badge } from '@/components/ds/core/Badge'

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

  const rating = formatRating(tester.ratingAverage)

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

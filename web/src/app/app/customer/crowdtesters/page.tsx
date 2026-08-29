import { requireRole } from '@/lib/auth/session'
import { loadList } from '@/lib/admin/list'
import { serverFetchOrNull } from '@/lib/api/server'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Avatar } from '@/components/admin/Avatar'
import { CountryLabel } from '@/components/admin/CountryFlag'
import { Pagination } from '@/components/ds/admin/Pagination'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { parsePage, pageHrefBuilder } from '@/lib/admin/list'
import { countryOptions } from '@/lib/admin/locales'

const ROOT = { label: 'Customer', href: '/app/customer' }
const BASE = '/app/customer/crowdtesters'
const PAGE_SIZE = 24

/**
 * `/app/customer/crowdtesters` — §44, browsing the testing crowd.
 *
 * ── ON NAMES
 *
 * Most of the crowd appears by initials. A tester's name and picture show only
 * once they have actually worked on one of this organisation's builds — the
 * API decides that, per row, and never sends the name otherwise.
 *
 * The reasoning is in `discoverTesters` on the API: a client browsing the pool
 * is judging capability, and country, rating, skills and platforms answer that
 * completely. A name adds nothing to the decision while making the entire
 * crowd personally identifiable to anyone who signs up. The banner below says
 * so plainly rather than leaving a wall of initials looking like a bug.
 *
 * Search matches headline, profession and skills — never a name, so this
 * cannot be used to check whether a particular person is on the platform.
 */

interface CrowdTester {
  id: string
  displayName: string
  isNamed: boolean
  avatarFileId: string | null
  headline: string | null
  profession: string | null
  countryCode: string | null
  /** A Prisma Decimal — arrives as a string. */
  ratingAverage: string | null
  ratingCount: number
  bugsAcceptedCount: number
  projectsCompletedCount: number
  experienceYears: number | null
  skills: readonly { id: string; name: string; slug: string }[]
  platforms: readonly string[]
}

interface SkillCatalog {
  skillCategories: readonly {
    id: string
    name: string
    skills: readonly { id: string; name: string; slug: string }[]
  }[]
}

function formatRating(raw: string | null): string | null {
  if (raw == null) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value.toFixed(1) : null
}

export default async function CrowdtestersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string; countryCode?: string; skills?: string }>
}) {
  await requireRole(['CUSTOMER'])
  const params = await searchParams
  const page = parsePage(params.page)
  const search = params.search ?? ''
  const countryCode = params.countryCode ?? ''
  const skills = params.skills ?? ''

  const [result, catalog] = await Promise.all([
    loadList<CrowdTester>('testers/discover', {
      page,
      limit: PAGE_SIZE,
      query: { search, countryCode, skills },
    }),
    // The skill filter offers what an admin actually configured (§71).
    serverFetchOrNull<SkillCatalog>('catalog'),
  ])

  const testers = 'items' in result ? result.items : []
  const failed = 'error' in result
  const meta = 'meta' in result ? result.meta : null

  const skillOptions = (catalog?.skillCategories ?? []).flatMap((c) =>
    c.skills.map((s) => ({ value: s.slug, label: `${s.name}` })),
  )

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Crowdtesters' }]}
      eyebrow="Delivery"
      title="Crowdtesters"
      subtitle={
        meta ? `${meta.total} verified tester${meta.total === 1 ? '' : 's'} available.` : undefined
      }
    >
      <Panel title="Find testers" description="Filter the crowd by where they are and what they do.">
        <LiveGetForm
          action={BASE}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'flex-end' }}
        >
          <Field
            label="Search"
            htmlFor="search"
            hint="Matches headline, profession and skills."
            style={{ flex: '2 1 240px' }}
          >
            <Input
              id="search"
              name="search"
              type="search"
              defaultValue={search}
              placeholder="Payments, accessibility, automation…"
              iconLeft="search"
            />
          </Field>
          <Field label="Country" htmlFor="countryCode" style={{ flex: '1 1 200px', maxWidth: 240 }}>
            <Select
              id="countryCode"
              name="countryCode"
              defaultValue={countryCode}
              options={[{ value: '', label: 'Any country' }, ...countryOptions()]}
            />
          </Field>
          <Field label="Skill" htmlFor="skills" style={{ flex: '1 1 200px', maxWidth: 240 }}>
            <Select
              id="skills"
              name="skills"
              defaultValue={skills}
              options={[{ value: '', label: 'Any skill' }, ...skillOptions]}
            />
          </Field>
          <LiveFormStatus />
        </LiveGetForm>
      </Panel>

      {/* Said once, near the results, rather than repeated on every card. */}
      <p
        style={{
          margin: 0,
          color: 'var(--text-muted)',
          fontSize: 'var(--type-body-sm-size)',
          maxWidth: '80ch',
        }}
      >
        Testers appear by their initials until they have worked on one of your builds. Their
        experience, rating and skills are shown either way.
      </p>

      {failed ? (
        <EmptyState
          icon="alert-triangle"
          title="The crowd could not be loaded"
          description="Refresh in a moment."
        />
      ) : testers.length === 0 ? (
        <EmptyState
          icon="users"
          title="No testers match those filters"
          description="Try a broader search, or clear the country and skill filters."
        />
      ) : (
        <>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            {testers.map((tester) => {
              const rating = formatRating(tester.ratingAverage)
              return (
                <li
                  key={tester.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-5)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--surface-canvas)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <Avatar
                      name={tester.displayName}
                      fileId={tester.avatarFileId}
                      size="md"
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span
                        style={{
                          fontWeight: 'var(--fw-semibold)',
                          color: 'var(--text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {tester.displayName}
                      </span>
                      <span
                        style={{
                          fontSize: 'var(--type-body-sm-size)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {tester.profession ?? tester.headline ?? 'Tester'}
                      </span>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-4)',
                      flexWrap: 'wrap',
                      fontSize: 'var(--type-body-sm-size)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {tester.countryCode ? (
                      <CountryLabel countryCode={tester.countryCode} size={14} />
                    ) : null}
                    {rating ? (
                      <span>
                        {rating} ({tester.ratingCount})
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>Not yet rated</span>
                    )}
                  </div>

                  {tester.skills.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                      {tester.skills.slice(0, 4).map((skill) => (
                        <Badge key={skill.id} tone="neutral" uppercase={false}>
                          {skill.name}
                        </Badge>
                      ))}
                      {tester.skills.length > 4 ? (
                        <span
                          style={{
                            fontSize: 'var(--type-caption-size)',
                            color: 'var(--text-muted)',
                            alignSelf: 'center',
                          }}
                        >
                          +{tester.skills.length - 4}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--space-4)',
                      fontSize: 'var(--type-caption-size)',
                      color: 'var(--text-muted)',
                      marginTop: 'auto',
                      paddingTop: 'var(--space-2)',
                    }}
                  >
                    <span>{tester.bugsAcceptedCount} accepted</span>
                    <span>{tester.projectsCompletedCount} projects</span>
                    {tester.experienceYears != null ? (
                      <span>{tester.experienceYears}y experience</span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>

          {meta ? (
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              limit={meta.limit}
              hrefFor={pageHrefBuilder(BASE, { search, countryCode, skills })}
            />
          ) : null}
        </>
      )}
    </DetailShell>
  )
}

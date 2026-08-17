import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { Avatar } from '@/components/admin/Avatar'
import { CountryFlag } from '@/components/admin/CountryFlag'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Pagination } from '@/components/ds/admin/Pagination'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requirePermission, hasPermission } from '@/lib/auth/session'
import { serverFetch } from '@/lib/api/server'
import { loadList, parsePage } from '@/lib/admin/list'
import { ApiError } from '@/lib/api/types'
import { formatDate, personName, stars, titleCase } from '@/lib/admin/format'
import { setTesterStatus, rejectTester } from './actions'

/**
 * `/app/admin/testers/[id]` — one crowd tester, §2.2 "Onboard, verify, manage,
 * and monitor the crowd tester pool, including tester profiles and status".
 *
 * The route param is the **TesterProfile** id. Ratings are keyed by USER id, so
 * the ratings read uses `profile.user.id` from the response rather than the param
 * — passing the profile id there returns an empty list rather than an error,
 * which is the kind of bug that looks like "this tester has no reviews".
 *
 * Two columns: the profile, devices, skills and reviews on the left, because they
 * are the volume; the verification workflow and the performance counters on the
 * right, because each is one control or one short list.
 */

const BASE = '/app/admin/testers'
const RATINGS_PAGE_SIZE = 10

/** The transitions that need no reason. REJECTED has its own form. */
const WORKFLOW_STATUSES = ['APPLIED', 'UNDER_REVIEW', 'VERIFIED', 'SUSPENDED'] as const

const WORKFLOW_OPTIONS = WORKFLOW_STATUSES.map((status) => ({
  value: status,
  label: titleCase(status),
}))

interface TesterDevice {
  id: string
  type: string
  manufacturer: string | null
  model: string
  osName: string | null
  osVersion: string | null
  screenSize: string | null
  ramGb: string | null
  network: string | null
  browser: string | null
  isPrimary: boolean
  createdAt: string
}

interface TesterDetail {
  id: string
  status: string
  headline: string | null
  bio: string | null
  experienceYears: number | null
  city: string | null
  countryCode: string | null
  /** Prisma Decimal — serialised as a STRING, not a number. See `toRating`. */
  ratingAverage: string | number | null
  ratingCount: number
  bugsReportedCount: number
  bugsAcceptedCount: number
  projectsCompletedCount: number
  verifiedAt: string | null
  rejectionReason: string | null
  ndaAcceptedAt: string | null
  createdAt: string
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    status: string
    avatarFileId: string | null
    phone: string | null
    timezone: string | null
    role: string
    lastLoginAt: string | null
    createdAt: string
  }
  devices: TesterDevice[]
  skills: { skill: { id: string; name: string; slug: string } }[]
  languages: { code: string; proficiency: string }[]
  workHistory: WorkHistoryEntry[]
}

interface WorkHistoryEntry {
  id: string
  company: string
  jobTitle: string
  startDate: string
  endDate: string | null
  description: string | null
}

interface RatingRow {
  id: string
  subjectType: string
  score: number
  comment: string | null
  isVisible: boolean
  createdAt: string
  author: { id: string; firstName: string | null; lastName: string | null; role: string } | null
  project: { id: string; reference: string; title: string } | null
}

/**
 * `ratingAverage` is a `Decimal(3,2)` on the API side, and Prisma's Decimal
 * serialises through `toJSON` as a string — `"4.50"`, not `4.5`. Calling
 * `.toFixed()` on it straight from the response throws, so it is coerced once
 * here and every reader takes a real number or null.
 */
function toRating(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })

/** `hi` → `Hindi`. Falls back to the raw code for anything ISO does not know. */
function languageName(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

function yearsLabel(years: number): string {
  return years === 1 ? '1 year' : `${years} years`
}

/** A short muted line for a panel with nothing in it yet. */
function Muted({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
      {children}
    </p>
  )
}

/** A score as decorative glyphs plus the number that actually carries the value. */
function Score({ score }: { score: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
      <span aria-hidden="true" style={{ color: 'var(--accent-base)', letterSpacing: 1 }}>
        {stars(score)}
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{score}</span>
    </span>
  )
}

const FORM_STYLE = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-5)',
}

const deviceColumns: readonly TableColumn<TesterDevice>[] = [
  { key: 'type', header: 'Type', render: (device) => titleCase(device.type) },
  {
    key: 'model',
    header: 'Model',
    render: (device) => [device.manufacturer, device.model].filter(Boolean).join(' '),
    renderSecondary: (device) => device.screenSize ?? undefined,
  },
  {
    key: 'os',
    header: 'Operating system',
    render: (device) => device.osName ?? '—',
    renderSecondary: (device) => device.osVersion ?? undefined,
  },
  {
    key: 'specs',
    header: 'Hardware',
    render: (device) => device.ramGb ? `${device.ramGb} GB` : '—',
    renderSecondary: (device) => [device.network, device.browser].filter(Boolean).join(' · ') || undefined,
  },
  {
    key: 'primary',
    header: 'Primary',
    render: (device) =>
      device.isPrimary ? (
        <Badge tone="accent" uppercase={false}>
          Primary
        </Badge>
      ) : (
        <span style={{ color: 'var(--text-muted)' }}>—</span>
      ),
  },
]

const workHistoryColumns: readonly TableColumn<WorkHistoryEntry>[] = [
  {
    key: 'company',
    header: 'Company',
    render: (entry) => entry.company,
    renderSecondary: (entry) => entry.jobTitle,
  },
  {
    key: 'dates',
    header: 'Dates',
    render: (entry) =>
      `${formatDate(entry.startDate)} — ${entry.endDate ? formatDate(entry.endDate) : 'Present'}`,
  },
  {
    key: 'description',
    header: 'Description',
    render: (entry) => entry.description ?? '—',
  },
]

const ratingColumns: readonly TableColumn<RatingRow>[] = [
  { key: 'score', header: 'Score', width: 130, render: (row) => <Score score={row.score} /> },
  {
    key: 'author',
    header: 'From',
    render: (row) => personName(row.author),
    renderSecondary: (row) => (row.author ? titleCase(row.author.role) : undefined),
  },
  {
    key: 'comment',
    header: 'Comment',
    render: (row) => row.comment ?? '—',
    renderSecondary: (row) => row.project?.title,
  },
  {
    key: 'visible',
    header: 'Visibility',
    render: (row) =>
      row.isVisible ? (
        <Badge tone="success" uppercase={false}>
          Visible
        </Badge>
      ) : (
        <Badge tone="error" uppercase={false}>
          Hidden
        </Badge>
      ),
  },
  { key: 'created', header: 'Left', align: 'right', render: (row) => formatDate(row.createdAt) },
]

/**
 * Seven panels, read for four different reasons: who this person is, what
 * they can test on, what they can test, and how they have performed. The
 * profile tab keeps the three identity panels together because they are
 * read as one thing; everything else earns its own tab.
 *
 * Verification and performance stay in the aside — they are the decision
 * you came to make, and they have to stay visible whichever tab is open.
 */
const SECTIONS = [
  { value: 'profile', label: 'Profile', icon: 'user-check' },
  { value: 'devices', label: 'Devices', icon: 'smartphone' },
  { value: 'skills', label: 'Skills and languages', icon: 'briefcase' },
  { value: 'work', label: 'Work history', icon: 'clipboard-check' },
  { value: 'ratings', label: 'Ratings', icon: 'star' },
] as const

export default async function TesterDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ ratingsPage?: string; section?: string }>
}) {
  const viewer = await requirePermission('tester.read')

  const { id } = await params
  const { ratingsPage, section: rawSection } = await searchParams
  const section = resolveSection(SECTIONS, rawSection)

  let tester: TesterDetail | null = null
  let loadError: 'forbidden' | 'unknown' | null = null

  try {
    // `serverFetch` already unwraps the `{ data }` envelope — this IS the profile.
    tester = await serverFetch<TesterDetail>(`testers/${id}`)
    // Defensive: an API version skew (mid-deploy, stale cache) could omit a
    // field this page now expects. Normalise rather than crash on `.length`.
    if (tester) tester.workHistory ??= []
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    loadError = err instanceof ApiError && err.status === 403 ? 'forbidden' : 'unknown'
  }

  if (!tester) {
    return (
      <DetailShell
        crumbs={[{ label: 'Testers', href: BASE }, { label: 'Unavailable' }]}
        eyebrow="Accounts"
        title="Tester unavailable"
      >
        {loadError === 'forbidden' ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this tester"
            description="Ask an administrator to grant you the tester.read permission."
            action={
              <Button href={BASE} variant="secondary" iconLeft="arrow-left">
                Back to testers
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon="alert-triangle"
            title="Couldn't load this tester"
            description="The testers service is unreachable. Refresh in a moment."
            action={
              <Button href={BASE} variant="secondary" iconLeft="arrow-left">
                Back to testers
              </Button>
            }
          />
        )}
      </DetailShell>
    )
  }

  const detailPath = `${BASE}/${tester.id}`
  const canVerify = hasPermission(viewer, 'tester.verify')

  // Ratings are keyed by user id, not profile id.
  const ratings = await loadList<RatingRow>('ratings', {
    page: parsePage(ratingsPage),
    limit: RATINGS_PAGE_SIZE,
    query: { subjectUserId: tester.user.id },
  })

  const ratingRows = 'error' in ratings ? [] : ratings.items
  const average = toRating(tester.ratingAverage)
  const location = [tester.city, tester.countryCode].filter(Boolean).join(', ')
  const currentWorkflowStatus = (WORKFLOW_STATUSES as readonly string[]).includes(tester.status)
    ? tester.status
    : 'UNDER_REVIEW'

  return (
    <DetailShell
      crumbs={[{ label: 'Testers', href: BASE }, { label: personName(tester.user) }]}
      eyebrow="Accounts"
      title={personName(tester.user)}
      subtitle={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Avatar name={personName(tester.user)} fileId={tester.user.avatarFileId} size="md" />
          <span>
            {tester.user.email} · Applied {formatDate(tester.createdAt)}
          </span>
        </span>
      }
      badges={
        <>
          <StatusBadge status={tester.status} />
          {tester.ndaAcceptedAt ? (
            <Badge tone="success" uppercase={false}>
              NDA accepted
            </Badge>
          ) : (
            <Badge tone="warning" uppercase={false}>
              NDA not accepted
            </Badge>
          )}
        </>
      }
      tabs={<SectionTabs basePath={detailPath} tabs={SECTIONS} active={section} />}
      aside={
        <>
          <Panel
            title="Verification"
            description="Where this application sits in review. We notify the tester on every change."
          >
            {canVerify ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-7)' }}>
                <TrackedForm action={setTesterStatus} style={FORM_STYLE}>
                  <input type="hidden" name="id" value={tester.id} />
                  <Field
                    label="Status"
                    htmlFor="status"
                    hint="Suspending also suspends the account, so the tester is signed out on their next request."
                  >
                    <Select
                      id="status"
                      name="status"
                      defaultValue={currentWorkflowStatus}
                      options={WORKFLOW_OPTIONS}
                    />
                  </Field>
                  <Field
                    label="Note to the tester"
                    htmlFor="note"
                    hint="Optional. We include it in the notification."
                  >
                    <Textarea
                      id="note"
                      name="note"
                      rows={3}
                      maxLength={1000}
                      placeholder="What changed, and what happens next"
                    />
                  </Field>
                  <Button type="submit" variant="primary" fullWidth>
                    Save status
                  </Button>
                </TrackedForm>

                <form
                  action={rejectTester}
                  style={{
                    ...FORM_STYLE,
                    paddingTop: 'var(--space-6)',
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <input type="hidden" name="id" value={tester.id} />
                  <Field
                    label="Reject this application"
                    htmlFor="reason"
                    required
                    hint="The reason is required, and the tester reads it. Say what was missing so they can reapply."
                  >
                    <Textarea
                      id="reason"
                      name="reason"
                      rows={4}
                      required
                      maxLength={1000}
                      defaultValue={tester.rejectionReason ?? ''}
                      placeholder="Which checks did not pass"
                    />
                  </Field>
                  <Button type="submit" variant="secondary" fullWidth>
                    Reject application
                  </Button>
                </form>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                  lineHeight: 1.55,
                }}
              >
                <Icon name="lock" size={20} style={{ flexShrink: 0 }} />
                <p style={{ margin: 0 }}>
                  Ask an administrator to grant you the tester.verify permission. It covers
                  verifying, rejecting, suspending and reinstating a tester.
                </p>
              </div>
            )}
          </Panel>

          <Panel
            title="Performance"
            description="Recomputed by the API after every bug and rating write."
          >
            <DescriptionList
              items={[
                {
                  label: 'Average rating',
                  value: average === null ? null : <Score score={Math.round(average * 10) / 10} />,
                },
                { label: 'Ratings received', value: tester.ratingCount },
                { label: 'Bugs reported', value: tester.bugsReportedCount },
                { label: 'Bugs accepted', value: tester.bugsAcceptedCount },
                { label: 'Projects completed', value: tester.projectsCompletedCount },
              ]}
            />
          </Panel>
        </>
      }
    >
      {section === 'profile' ? (
        <>
          <Panel title="Profile" description="Maintained by the tester, reviewed by us.">
            <DescriptionList
              items={[
                { label: 'Headline', value: tester.headline },
                {
                  label: 'Experience',
                  value: tester.experienceYears === null ? null : yearsLabel(tester.experienceYears),
                },
                {
                  label: 'Location',
                  value: location ? (
                    <span
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
                    >
                      <CountryFlag countryCode={tester.countryCode} size={16} />
                      <span>{location}</span>
                    </span>
                  ) : null,
                },
                { label: 'Account', value: <StatusBadge status={tester.user.status} /> },
                {
                  label: 'NDA accepted',
                  value: tester.ndaAcceptedAt ? formatDate(tester.ndaAcceptedAt) : null,
                },
                { label: 'Verified', value: tester.verifiedAt ? formatDate(tester.verifiedAt) : null },
                { label: 'Bio', value: tester.bio, wide: true },
                { label: 'Rejection reason', value: tester.rejectionReason, wide: true },
              ]}
            />
          </Panel>

          <Panel title="Contact info" description="How to reach this tester outside the platform.">
            <DescriptionList
              items={[
                { label: 'Email', value: tester.user.email },
                { label: 'Phone', value: tester.user.phone },
              ]}
            />
          </Panel>

          <Panel title="Account details" description="The account this tester profile is attached to.">
            <DescriptionList
              items={[
                { label: 'Role', value: titleCase(tester.user.role) },
                { label: 'Member since', value: formatDate(tester.user.createdAt) },
                {
                  label: 'Last sign-in',
                  value: tester.user.lastLoginAt ? formatDate(tester.user.lastLoginAt) : 'Never',
                },
                { label: 'Timezone', value: tester.user.timezone },
              ]}
            />
          </Panel>
        </>
      ) : null}

      {section === 'devices' ? (
        <>
          <Panel
            title="Devices"
            description="What this tester can test on. One device is marked primary."
            flush={tester.devices.length > 0}
          >
            {tester.devices.length > 0 ? (
              <Table
                ariaLabel="Devices"
                columns={deviceColumns}
                rows={tester.devices}
                rowKey={(device) => device.id}
              />
            ) : (
              <Muted>
                No devices listed. A tester adds their own devices, and cannot be assigned
                device-specific work until they do.
              </Muted>
            )}
          </Panel>
        </>
      ) : null}

      {section === 'work' ? (
        <>
          <Panel
            title="Work history"
            description="Prior testing and QA experience, maintained by the tester on their own profile."
            flush={tester.workHistory.length > 0}
          >
            {tester.workHistory.length > 0 ? (
              <Table
                ariaLabel="Work history"
                columns={workHistoryColumns}
                rows={tester.workHistory}
                rowKey={(entry) => entry.id}
              />
            ) : (
              <Muted>No work history listed yet.</Muted>
            )}
          </Panel>
        </>
      ) : null}

      {section === 'skills' ? (
        <>
          <Panel
            title="Skills and languages"
            description="Both sets are maintained by the tester on their own profile."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              <div>
                <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-3)' }}>
                  Skills
                </p>
                {tester.skills.length > 0 ? (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 'var(--space-2)',
                    }}
                  >
                    {tester.skills.map(({ skill }) => (
                      <li key={skill.id}>
                        <Badge tone="brand" uppercase={false}>
                          {skill.name}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Muted>No skills recorded yet.</Muted>
                )}
              </div>

              <div>
                <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-3)' }}>
                  Languages
                </p>
                {tester.languages.length > 0 ? (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-2)',
                      maxWidth: '40ch',
                    }}
                  >
                    {tester.languages.map((language) => (
                      <li
                        key={language.code}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 'var(--space-4)',
                          fontSize: 'var(--type-body-sm-size)',
                        }}
                      >
                        <span style={{ color: 'var(--text-primary)' }}>
                          {languageName(language.code)}
                        </span>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {titleCase(language.proficiency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Muted>No languages recorded yet.</Muted>
                )}
              </div>
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'ratings' ? (
        <>
          <Panel
            title="Ratings received"
            description="Reviews left on this tester. Hidden reviews stay listed, and are left out of the average."
            actions={
              <Link
                href={`/app/admin/ratings?subjectUserId=${tester.user.id}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-input)',
                  border: '1px solid var(--border-default)',
                  fontSize: 'var(--type-body-sm-size)',
                  color: 'var(--text-primary)',
                  textDecoration: 'none',
                }}
              >
                View all
                <Icon name="arrow-right" size={14} />
              </Link>
            }
            flush={ratingRows.length > 0}
          >
            {'error' in ratings ? (
              <Muted>
                {ratings.error === 'forbidden'
                  ? 'Ask an administrator to grant you the rating.read permission.'
                  : 'The ratings service is unreachable. Refresh in a moment.'}
              </Muted>
            ) : ratingRows.length === 0 ? (
              <Muted>
                No ratings yet. One appears here when a customer reviews this tester on a project they
                worked on together.
              </Muted>
            ) : (
              <>
                <Table
                  ariaLabel="Ratings received"
                  columns={ratingColumns}
                  rows={ratingRows}
                  rowKey={(row) => row.id}
                />
                <div
                  style={{
                    padding: 'var(--space-5) var(--space-6)',
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <Pagination
                    page={ratings.meta.page}
                    totalPages={Math.max(1, ratings.meta.totalPages)}
                    total={ratings.meta.total}
                    limit={ratings.meta.limit}
                    hrefFor={(target) =>
                      target > 1
                        ? `${detailPath}?section=ratings&ratingsPage=${target}`
                        : `${detailPath}?section=ratings`
                    }
                  />
                </div>
              </>
            )}
          </Panel>
        </>
      ) : null}

    </DetailShell>
  )
}

import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Topbar } from '@/components/admin/Topbar'
import { AssetsTabs } from '../tabs'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Select } from '@/components/ds/forms/Select'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'

const BASE = '/app/admin/assets/skills'
const SORT_OPTIONS = [
  { value: 'count', label: 'Tester count' },
  { value: 'name', label: 'Name' },
] as const

interface Catalog {
  skillCategories: readonly {
    id: string
    name: string
    slug: string
    isActive: boolean
    skills: readonly {
      id: string
      name: string
      slug: string
      isActive: boolean
      _count: { testers: number }
    }[]
  }[]
}

interface SkillRow {
  id: string
  name: string
  slug: string
  isActive: boolean
  categoryName: string
  categorySlug: string
  testerCount: number
}

/**
 * Build a URL against this page preserving whichever of the current filters
 * aren't being overridden — used by the "show retired" toggle so it doesn't
 * reset the category/sort the reader already picked.
 */
function hrefWith(
  current: { category?: string; sort?: string; order?: string; all?: string },
  overrides: { all?: string },
): string {
  const sp = new URLSearchParams()
  const merged = { ...current, ...overrides }
  for (const [key, value] of Object.entries(merged)) {
    if (value) sp.set(key, value)
  }
  const qs = sp.toString()
  return qs ? `${BASE}?${qs}` : BASE
}

/**
 * `/app/admin/assets/skills` — every catalog skill with how many testers
 * have picked it, aggregated across the whole platform (§14-16).
 *
 * This is a THIRD view over the exact same `Skill`/`TesterSkill` rows that
 * Catalog > Skills (definitions) and a tester's own profile (their picks)
 * already show — no second skill store. Catalog owns creating and retiring a
 * skill; a tester's profile owns which skills apply to them; this page only
 * counts and cross-links the two.
 */
export default async function SkillsAssetPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; sort?: string; order?: string; all?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const params = await searchParams
  const showAll = params.all === 'true'
  const sort = params.sort === 'name' ? 'name' : 'count'
  const order =
    params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : sort === 'name' ? 'asc' : 'desc'

  const catalog = await serverFetchOrNull<Catalog>(showAll ? 'catalog?all=true' : 'catalog')

  if (!catalog) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Assets', href: '/app/admin/assets/devices' }, { label: 'Skills' }]} />
        <main id="main" style={{ padding: 'var(--space-9)' }}>
          <EmptyState
            icon="alert-triangle"
            title="Could not load skills"
            description="The service is unreachable. Refresh in a moment."
          />
        </main>
      </>
    )
  }

  const category = catalog.skillCategories.find((c) => c.slug === params.category)?.slug

  let rows: SkillRow[] = catalog.skillCategories.flatMap((c) =>
    c.skills.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      isActive: s.isActive,
      categoryName: c.name,
      categorySlug: c.slug,
      testerCount: s._count.testers,
    })),
  )

  if (category) rows = rows.filter((row) => row.categorySlug === category)

  rows = rows.slice().sort((a, b) => {
    const cmp = sort === 'name' ? a.name.localeCompare(b.name) : a.testerCount - b.testerCount
    return order === 'asc' ? cmp : -cmp
  })

  const columns: readonly TableColumn<SkillRow>[] = [
    {
      key: 'skill',
      header: 'Skill',
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {row.name}
          {!row.isActive ? (
            <Badge tone="neutral" uppercase={false}>
              Retired
            </Badge>
          ) : null}
        </span>
      ),
      renderSecondary: (row) => row.categoryName,
    },
    {
      key: 'count',
      header: 'Testers',
      align: 'right',
      render: (row) => String(row.testerCount),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) =>
        row.testerCount > 0 ? (
          <Link
            href={`/app/admin/testers?skills=${row.slug}`}
            style={{
              color: 'var(--text-brand)',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            View testers
          </Link>
        ) : null,
    },
  ]

  return (
    <>
      <Topbar crumbs={[{ label: 'Assets', href: '/app/admin/assets/devices' }, { label: 'Skills' }]} />
      <main
        id="main"
        style={{ padding: 'var(--space-9)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
            Assets
          </p>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            Skills
          </h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}>
            Every catalog skill and how many testers have picked it. Manage the skill list itself
            under Operations &rsaquo; Catalog &rsaquo; Skills — this page only counts and
            cross-links what testers have already chosen from there.
          </p>
          <div style={{ marginTop: 'var(--space-2)' }}>
            <Button href={hrefWith(params, { all: showAll ? undefined : 'true' })} variant="secondary" size="sm">
              {showAll ? 'Hide retired skills' : 'Show retired skills'}
            </Button>
          </div>
        </header>

        <AssetsTabs active="skills" />

        <LiveGetForm
          action={BASE}
          style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          {showAll ? <input type="hidden" name="all" value="true" /> : null}
          <Field label="Category" htmlFor="category">
            <Select
              id="category"
              name="category"
              defaultValue={category ?? ''}
              options={[
                { value: '', label: 'All categories' },
                ...catalog.skillCategories.map((c) => ({ value: c.slug, label: c.name })),
              ]}
            />
          </Field>
          <Field label="Sort by" htmlFor="sort">
            <Select id="sort" name="sort" defaultValue={sort} options={SORT_OPTIONS} />
          </Field>
          <Field label="Order" htmlFor="order">
            <Select
              id="order"
              name="order"
              defaultValue={order}
              options={[
                { value: 'desc', label: 'Descending' },
                { value: 'asc', label: 'Ascending' },
              ]}
            />
          </Field>
          <LiveFormStatus />
          {category ? (
            <Button href={hrefWith({ sort: params.sort, order: params.order, all: params.all }, {})} variant="ghost">
              Clear
            </Button>
          ) : null}
        </LiveGetForm>

        {rows.length === 0 ? (
          <EmptyState
            icon="graduation-cap"
            title={category ? 'No skills in this category' : 'No skills yet'}
            description={
              category
                ? 'Try another category, or clear the filter.'
                : 'Add skills under Operations › Catalog › Skills.'
            }
          />
        ) : (
          <Table ariaLabel="Skills" columns={columns} rows={rows} rowKey={(row) => row.id} />
        )}
      </main>
    </>
  )
}

import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Panel } from '@/components/admin/Panel'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { titleCase } from '@/lib/admin/format'
import {
  addBrandAction,
  addModelAction,
  addBrowserAction,
  addBrowserVersionAction,
  addOsVersionAction,
  addNetworkAction,
  addSkillCategoryAction,
  addSkillAction,
} from './actions'

/**
 * The catalog is seven independent reference lists. Stacked, they were one
 * long scroll where finding carriers meant passing every device model; the
 * lists also have nothing to do with one another, so there is no reading
 * order that makes them one page. Tabs give each list the full viewport and
 * make the catalog's shape visible before you scroll at all.
 *
 * Skill categories and skills joined this page rather than getting their own
 * sidebar entry — they were a standalone "Skills" item before, but a skill is
 * exactly the same kind of thing as a browser or a network provider: a
 * controlled list a tester picks from rather than types.
 */
const SECTIONS = [
  { value: 'devices', label: 'Device models', icon: 'smartphone' },
  { value: 'brands', label: 'Brands', icon: 'briefcase' },
  { value: 'os', label: 'Operating systems', icon: 'monitor' },
  { value: 'browsers', label: 'Browsers', icon: 'globe' },
  { value: 'networks', label: 'Network providers', icon: 'plug' },
  { value: 'skill-categories', label: 'Skill categories', icon: 'layout-grid' },
  { value: 'skills', label: 'Skills', icon: 'graduation-cap' },
] as const

/**
 * Seven lists read more clearly as four families than as one flat row of
 * tabs — Device models / Brands / Operating systems are all facets of "what
 * a tester's kit is", and Skill categories / Skills are "definition" and
 * "the definitions inside it" for the exact same underlying data. Browsers
 * and Network providers stand alone because there is nothing else in their
 * family.
 *
 * Each group's own default (the tab a bare click on the group lands on) is
 * its first member — Devices → Device models, Skills → Skills itself, since
 * that is the list someone reaches for, not the categories behind it.
 */
const GROUPS = [
  { key: 'devices', label: 'Devices', icon: 'smartphone', sections: ['devices', 'brands', 'os'] },
  { key: 'browsers', label: 'Browsers', icon: 'globe', sections: ['browsers'] },
  { key: 'networks', label: 'Network providers', icon: 'plug', sections: ['networks'] },
  { key: 'skills', label: 'Skills', icon: 'graduation-cap', sections: ['skills', 'skill-categories'] },
] as const satisfies readonly { key: string; label: string; icon: string; sections: readonly string[] }[]

function groupFor(section: string): (typeof GROUPS)[number] {
  return GROUPS.find((g) => (g.sections as readonly string[]).includes(section)) ?? GROUPS[0]
}

const DEVICE_TYPES = ['MOBILE', 'TABLET', 'DESKTOP', 'SMART_TV', 'WEARABLE', 'OTHER'] as const

interface Catalog {
  brands: readonly { id: string; name: string; isActive: boolean }[]
  deviceModels: readonly {
    id: string
    name: string
    type: string
    ramGb: string | null
    screenSize: string | null
    isActive: boolean
    brand: { id: string; name: string }
    defaultOs: { id: string; name: string; kind: string } | null
  }[]
  operatingSystems: readonly {
    id: string
    name: string
    kind: string
    isActive: boolean
    versions: readonly { id: string; version: string; isActive: boolean }[]
  }[]
  browsers: readonly {
    id: string
    name: string
    isActive: boolean
    versions: readonly { id: string; version: string; isActive: boolean }[]
  }[]
  networks: readonly { id: string; name: string; countryCode: string | null; isActive: boolean }[]
  skillCategories: readonly {
    id: string
    name: string
    slug: string
    isActive: boolean
    skills: readonly { id: string; name: string; slug: string; isActive: boolean }[]
  }[]
}

const ROW: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) var(--space-4)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--surface-canvas)',
}

const LIST: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
}

/**
 * A wrapping row of pills rather than one-per-line rows — for lists that are
 * genuinely just a name (brands, network providers). Device models, OSes and
 * browsers keep the row layout above: each of those carries real per-item
 * detail (type/RAM, a versions list, an inline add-version form) that a chip
 * has no room for. Only convert a list here if every row really is just a
 * name — that's the difference between "compact" and "lossy".
 */
const CHIP_LIST: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2)',
}

const CHIP: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: 'var(--space-1) var(--space-3)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-full)',
  background: 'var(--surface-canvas)',
  fontSize: 'var(--type-body-sm-size)',
  color: 'var(--text-primary)',
  lineHeight: 'var(--type-body-sm-line)',
}

/** A retired chip stays legible (not just faded to nothing) — dimmed text plus a compact inline label beats a full `Badge` per chip, which would fight the point of being compact. */
const CHIP_RETIRED: React.CSSProperties = {
  ...CHIP,
  color: 'var(--text-muted)',
  borderStyle: 'dashed',
}

const INLINE_FORM: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--space-3)',
  alignItems: 'flex-end',
  flexWrap: 'wrap',
  paddingTop: 'var(--space-4)',
  borderTop: '1px solid var(--border-subtle)',
  marginTop: 'var(--space-4)',
}

/**
 * `/app/admin/catalog` — the device / browser reference catalog (§18).
 *
 * Recovers ten legacy tables: `mobile_brands`, `mobile_os_type`, `os`,
 * `mobile_os_version`, `os_versions`, `browsers`, `browser_versions`,
 * `network_providers`, the catalog half of `devices`, and `user_browsers`.
 *
 * One sidebar entry, five tabs — not nine sidebar entries. The legacy system's
 * split across nine tables is a storage concern, and promoting it into
 * top-level navigation would bury five short reference lists under more
 * chrome than content. Tabs keep the catalog a single destination while giving
 * each list the whole viewport.
 *
 * Catalog data is global, not tenant-scoped — see the schema comment on
 * `DeviceBrand` for why.
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; error?: string; section?: string }>
}) {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const params = await searchParams
  const showAll = params.all === 'true'
  const section = resolveSection(SECTIONS, params.section)
  const activeGroup = groupFor(section)

  const catalog = await serverFetchOrNull<Catalog>(
    showAll ? 'catalog?all=true' : 'catalog',
  )

  if (!catalog) {
    return (
      <main id="main" style={{ padding: 'var(--space-9)' }}>
        <EmptyState
          icon="alert-triangle"
          title="Could not load the catalog"
          description="The service is unreachable. Refresh in a moment."
        />
      </main>
    )
  }

  const mobileOs = catalog.operatingSystems.filter((o) => o.kind === 'MOBILE')
  const desktopOs = catalog.operatingSystems.filter((o) => o.kind === 'DESKTOP')

  return (
    <main
      id="main"
      style={{
        padding: 'var(--space-9)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
          Operations
        </p>
        <h1 className="c4t-display-md" style={{ margin: 0 }}>
          Device &amp; browser catalog
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}>
          The controlled lists testers pick from when describing their kit. Keeping these
          structured is what makes &ldquo;find every tester on Android 15&rdquo; answerable —
          free-text device names never match reliably. Retiring an entry hides it from new
          selections without breaking testers who already reference it.
        </p>
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Button
            href={showAll ? '/app/admin/catalog' : '/app/admin/catalog?all=true'}
            variant="secondary"
            size="sm"
          >
            {showAll ? 'Hide retired entries' : 'Show retired entries'}
          </Button>
        </div>
      </header>

      <SectionTabs
        basePath="/app/admin/catalog"
        tabs={GROUPS.map((g) => ({
          value: g.key,
          label: g.label,
          icon: g.icon,
          href: `/app/admin/catalog?section=${g.sections[0]}${showAll ? '&all=true' : ''}`,
        }))}
        active={activeGroup.key}
      />

      {params.error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-card)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          {params.error === 'duplicate'
            ? 'That entry already exists.'
            : 'Could not save that entry. Try again.'}
        </p>
      ) : null}

      {activeGroup.key === 'devices' ? (
      <Panel
        title="Device models"
        description={`${catalog.deviceModels.length} models across ${catalog.brands.length} brands.`}
      >
        {catalog.deviceModels.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>No device models yet.</p>
        ) : (
          <ul style={LIST}>
            {catalog.deviceModels.map((m) => (
              <li key={m.id} style={ROW}>
                <span>
                  <strong style={{ color: 'var(--text-primary)' }}>
                    {m.brand.name} {m.name}
                  </strong>
                  <span
                    style={{
                      marginLeft: 'var(--space-3)',
                      color: 'var(--text-muted)',
                      fontSize: 'var(--type-body-sm-size)',
                    }}
                  >
                    {[
                      titleCase(m.type),
                      m.defaultOs?.name,
                      m.ramGb ? `${m.ramGb} GB` : null,
                      m.screenSize ? `${m.screenSize}"` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {!m.isActive ? (
                  <Badge tone="neutral" uppercase={false}>
                    Retired
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <form action={addModelAction} style={INLINE_FORM}>
          <Field label="Brand" htmlFor="brandId">
            <Select
              id="brandId"
              name="brandId"
              required
              options={catalog.brands.map((b) => ({ value: b.id, label: b.name }))}
            />
          </Field>
          <Field label="Model" htmlFor="modelName">
            <Input id="modelName" name="name" required maxLength={160} placeholder="Galaxy S25" />
          </Field>
          <Field label="Type" htmlFor="modelType">
            <Select
              id="modelType"
              name="type"
              required
              defaultValue="MOBILE"
              options={DEVICE_TYPES.map((v) => ({ value: v, label: titleCase(v) }))}
            />
          </Field>
          <Field label="Default OS" htmlFor="defaultOsId">
            <Select
              id="defaultOsId"
              name="defaultOsId"
              defaultValue=""
              options={[
                { value: '', label: 'None' },
                ...catalog.operatingSystems.map((o) => ({
                  value: o.id,
                  label: `${o.name} (${titleCase(o.kind)})`,
                })),
              ]}
            />
          </Field>
          <Field label="RAM (GB)" htmlFor="ramGb">
            <Input id="ramGb" name="ramGb" maxLength={20} style={{ width: 90 }} />
          </Field>
          <Button type="submit" variant="secondary" iconLeft="plus">
            Add model
          </Button>
        </form>
      </Panel>
      ) : null}

      {activeGroup.key === 'devices' ? (
      <Panel title="Brands" description={`${catalog.brands.length} brands.`}>
        <ul style={CHIP_LIST}>
          {catalog.brands.map((b) => (
            <li key={b.id} style={b.isActive ? CHIP : CHIP_RETIRED}>
              {b.name}
              {!b.isActive ? (
                <span style={{ fontSize: 'var(--type-caption-size)' }}>· Retired</span>
              ) : null}
            </li>
          ))}
        </ul>
        <form action={addBrandAction} style={INLINE_FORM}>
          <Field label="Brand name" htmlFor="brandName">
            <Input id="brandName" name="name" required maxLength={120} placeholder="OnePlus" />
          </Field>
          <Button type="submit" variant="secondary" iconLeft="plus">
            Add brand
          </Button>
        </form>
      </Panel>
      ) : null}

      {activeGroup.key === 'devices' ? (
      <Panel
        title="Operating systems"
        description="Mobile and desktop, with their versions. One list — the legacy schema split these across four tables for no behavioural reason."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {[
            { label: 'Mobile', rows: mobileOs },
            { label: 'Desktop', rows: desktopOs },
          ].map((group) => (
            <div key={group.label}>
              <p
                className="c4t-eyebrow"
                style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-3)' }}
              >
                {group.label}
              </p>
              <ul style={LIST}>
                {group.rows.map((o) => (
                  <li key={o.id} style={{ ...ROW, alignItems: 'flex-start' }}>
                    <span>
                      <strong style={{ color: 'var(--text-primary)' }}>{o.name}</strong>
                      <span
                        style={{
                          display: 'block',
                          marginTop: 'var(--space-1)',
                          color: 'var(--text-muted)',
                          fontSize: 'var(--type-body-sm-size)',
                        }}
                      >
                        {o.versions.length > 0
                          ? o.versions.map((v) => v.version).join(', ')
                          : 'No versions yet'}
                      </span>
                    </span>
                    <form
                      action={addOsVersionAction}
                      style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
                    >
                      <input type="hidden" name="osId" value={o.id} />
                      <Input
                        name="version"
                        required
                        maxLength={60}
                        placeholder="Add version"
                        style={{ width: 130 }}
                        aria-label={`Add a version to ${o.name}`}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        Add
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>
      ) : null}

      {activeGroup.key === 'browsers' ? (
      <Panel title="Browsers" description={`${catalog.browsers.length} browsers.`}>
        <ul style={LIST}>
          {catalog.browsers.map((b) => (
            <li key={b.id} style={{ ...ROW, alignItems: 'flex-start' }}>
              <span>
                <strong style={{ color: 'var(--text-primary)' }}>{b.name}</strong>
                <span
                  style={{
                    display: 'block',
                    marginTop: 'var(--space-1)',
                    color: 'var(--text-muted)',
                    fontSize: 'var(--type-body-sm-size)',
                  }}
                >
                  {b.versions.length > 0
                    ? b.versions.map((v) => v.version).join(', ')
                    : 'No versions yet'}
                </span>
              </span>
              <form
                action={addBrowserVersionAction}
                style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
              >
                <input type="hidden" name="browserId" value={b.id} />
                <Input
                  name="version"
                  required
                  maxLength={60}
                  placeholder="Add version"
                  style={{ width: 130 }}
                  aria-label={`Add a version to ${b.name}`}
                />
                <Button type="submit" variant="ghost" size="sm">
                  Add
                </Button>
              </form>
            </li>
          ))}
        </ul>
        <form action={addBrowserAction} style={INLINE_FORM}>
          <Field label="Browser name" htmlFor="browserName">
            <Input id="browserName" name="name" required maxLength={120} placeholder="Opera" />
          </Field>
          <Button type="submit" variant="secondary" iconLeft="plus">
            Add browser
          </Button>
        </form>
      </Panel>
      ) : null}

      {activeGroup.key === 'networks' ? (
      <Panel title="Network providers" description={`${catalog.networks.length} carriers.`}>
        <ul style={CHIP_LIST}>
          {catalog.networks.map((n) => (
            <li key={n.id} style={n.isActive ? CHIP : CHIP_RETIRED}>
              {n.name}
              {n.countryCode ? (
                <span style={{ fontSize: 'var(--type-caption-size)', color: 'var(--text-muted)' }}>
                  {n.countryCode}
                </span>
              ) : null}
              {!n.isActive ? (
                <span style={{ fontSize: 'var(--type-caption-size)' }}>· Retired</span>
              ) : null}
            </li>
          ))}
        </ul>
        <form action={addNetworkAction} style={INLINE_FORM}>
          <Field label="Carrier" htmlFor="networkName">
            <Input id="networkName" name="name" required maxLength={120} placeholder="Orange" />
          </Field>
          <Field label="Country" htmlFor="networkCountry" hint="ISO 2-letter.">
            <Input
              id="networkCountry"
              name="countryCode"
              maxLength={2}
              style={{ width: 90, textTransform: 'uppercase' }}
            />
          </Field>
          <Button type="submit" variant="secondary" iconLeft="plus">
            Add carrier
          </Button>
        </form>
      </Panel>
      ) : null}

      {activeGroup.key === 'skills' ? (
      <Panel
        title="Skill categories"
        description={`${catalog.skillCategories.length} categories.`}
      >
        <ul style={LIST}>
          {catalog.skillCategories.map((c) => (
            <li key={c.id} style={ROW}>
              <span style={{ color: 'var(--text-primary)' }}>
                {c.name}
                <span
                  style={{
                    marginLeft: 'var(--space-3)',
                    color: 'var(--text-muted)',
                    fontSize: 'var(--type-body-sm-size)',
                  }}
                >
                  {c.skills.length} {c.skills.length === 1 ? 'skill' : 'skills'}
                </span>
              </span>
              {!c.isActive ? (
                <Badge tone="neutral" uppercase={false}>
                  Retired
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
        <form action={addSkillCategoryAction} style={INLINE_FORM}>
          <Field label="Category name" htmlFor="skillCategoryName">
            <Input
              id="skillCategoryName"
              name="name"
              required
              maxLength={120}
              placeholder="Domain knowledge"
            />
          </Field>
          <Button type="submit" variant="secondary" iconLeft="plus">
            Add category
          </Button>
        </form>
      </Panel>
      ) : null}

      {activeGroup.key === 'skills' ? (
      <Panel
        title="Skills"
        description="What a tester picks from when describing their expertise — no longer free text, so the list stays tidy instead of accumulating near-duplicates."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {catalog.skillCategories.map((c) => (
            <div key={c.id}>
              <p
                className="c4t-eyebrow"
                style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-3)' }}
              >
                {c.name}
              </p>
              {c.skills.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--text-muted)' }}>No skills yet.</p>
              ) : (
                <ul style={LIST}>
                  {c.skills.map((s) => (
                    <li key={s.id} style={ROW}>
                      <span style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                      {!s.isActive ? (
                        <Badge tone="neutral" uppercase={false}>
                          Retired
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <form action={addSkillAction} style={INLINE_FORM}>
          <Field label="Skill name" htmlFor="skillName">
            <Input
              id="skillName"
              name="name"
              required
              maxLength={120}
              placeholder="Contract testing"
            />
          </Field>
          <Field label="Category" htmlFor="skillCategoryId">
            <Select
              id="skillCategoryId"
              name="categoryId"
              required
              options={catalog.skillCategories.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
          <Button type="submit" variant="secondary" iconLeft="plus">
            Add skill
          </Button>
        </form>
      </Panel>
      ) : null}

    </main>
  )
}

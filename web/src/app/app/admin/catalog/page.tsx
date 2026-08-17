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
} from './actions'

/**
 * The catalog is five independent reference lists. Stacked, they were one
 * long scroll where finding carriers meant passing every device model; the
 * lists also have nothing to do with one another, so there is no reading
 * order that makes them one page. Tabs give each list the full viewport and
 * make the catalog's shape visible before you scroll at all.
 */
const SECTIONS = [
  { value: 'devices', label: 'Device models', icon: 'smartphone' },
  { value: 'brands', label: 'Brands', icon: 'briefcase' },
  { value: 'os', label: 'Operating systems', icon: 'monitor' },
  { value: 'browsers', label: 'Browsers', icon: 'globe' },
  { value: 'networks', label: 'Network providers', icon: 'plug' },
] as const

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
        tabs={SECTIONS}
        active={section}
        preserve={{ all: showAll ? 'true' : undefined }}
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

      {section === 'devices' ? (
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

      {section === 'brands' ? (
      <Panel title="Brands" description={`${catalog.brands.length} brands.`}>
        <ul style={LIST}>
          {catalog.brands.map((b) => (
            <li key={b.id} style={ROW}>
              <span style={{ color: 'var(--text-primary)' }}>{b.name}</span>
              {!b.isActive ? (
                <Badge tone="neutral" uppercase={false}>
                  Retired
                </Badge>
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

      {section === 'os' ? (
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

      {section === 'browsers' ? (
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

      {section === 'networks' ? (
      <Panel title="Network providers" description={`${catalog.networks.length} carriers.`}>
        <ul style={LIST}>
          {catalog.networks.map((n) => (
            <li key={n.id} style={ROW}>
              <span style={{ color: 'var(--text-primary)' }}>
                {n.name}
                {n.countryCode ? (
                  <span
                    style={{
                      marginLeft: 'var(--space-2)',
                      color: 'var(--text-muted)',
                      fontSize: 'var(--type-body-sm-size)',
                    }}
                  >
                    {n.countryCode}
                  </span>
                ) : null}
              </span>
              {!n.isActive ? (
                <Badge tone="neutral" uppercase={false}>
                  Retired
                </Badge>
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

    </main>
  )
}

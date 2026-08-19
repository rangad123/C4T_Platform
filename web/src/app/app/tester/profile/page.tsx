import type { ReactNode } from 'react'
import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Panel } from '@/components/admin/Panel'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Card, CardGrid } from '@/components/admin/Card'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { formatDate, titleCase } from '@/lib/admin/format'
import {
  updateBasicInfoAction,
  addDeviceAction,
  removeDeviceAction,
  setSkillsAction,
  addLanguageAction,
  removeLanguageAction,
  addWorkHistoryAction,
  removeWorkHistoryAction,
  acceptNdaAction,
  savePaymentAccountAction,
} from './actions'

const DEVICE_TYPES = ['MOBILE', 'TABLET', 'DESKTOP', 'SMART_TV', 'WEARABLE', 'OTHER'] as const
const PAYMENT_COUNTRIES = ['INDIAN', 'NON_INDIAN'] as const
const PAYMENT_TYPES = ['IND_BANK_ACCOUNT', 'NON_IND_BANK_ACCOUNT', 'PAYPAL', 'PAYTM'] as const
const PAYMENT_TYPE_LABEL: Record<(typeof PAYMENT_TYPES)[number], string> = {
  IND_BANK_ACCOUNT: 'Indian bank account',
  NON_IND_BANK_ACCOUNT: 'International bank account',
  PAYPAL: 'PayPal',
  PAYTM: 'Paytm',
}
const PROFICIENCIES = ['NATIVE', 'FLUENT', 'PROFESSIONAL', 'BASIC'] as const

interface TesterDevice {
  id: string
  type: string
  manufacturer: string | null
  model: string
  osName: string | null
  osVersion: string | null
  screenSize: string | null
  ramGb: string | null
  storageGb: string | null
  network: string | null
  browser: string | null
  isPrimary: boolean
}

interface WorkHistoryEntry {
  id: string
  company: string
  jobTitle: string
  startDate: string
  endDate: string | null
  description: string | null
}

interface ProfileDetail {
  id: string
  status: string
  headline: string | null
  bio: string | null
  experienceYears: number | null
  city: string | null
  countryCode: string | null
  ndaAcceptedAt: string | null
  devices: readonly TesterDevice[]
  skills: readonly { skill: { id: string; name: string } }[]
  languages: readonly { code: string; proficiency: string }[]
  workHistory: readonly WorkHistoryEntry[]
}

interface PaymentAccount {
  id: string
  country: string
  paymentType: string
  status: string
  bankName: string | null
  branchName: string | null
  accountNumberLast4: string | null
  paypalEmailMasked: string | null
  paytmNumberLast4: string | null
}

interface Catalog {
  brands: readonly { id: string; name: string }[]
  deviceModels: readonly {
    id: string
    name: string
    brand: { id: string; name: string }
    defaultOs: { id: string; name: string } | null
  }[]
  operatingSystems: readonly {
    id: string
    name: string
    kind: string
    versions: readonly { id: string; version: string }[]
  }[]
  networks: readonly { id: string; name: string; countryCode: string | null }[]
  skillCategories: readonly {
    id: string
    name: string
    skills: readonly { id: string; name: string }[]
  }[]
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
      {children}
    </span>
  )
}

const FORM_STYLE = { display: 'flex', flexDirection: 'column' as const, gap: 'var(--space-5)' }

/**
 * `/app/tester/profile` — the tester's own self-service profile.
 *
 * Every field on this page is edited through an API endpoint that already
 * existed before this pass — `PATCH /testers/me`, the device/work-history
 * add-remove pair, and the skills/languages full-replacement PUTs. Nothing
 * here needed an API change; the gap was entirely that no web UI called any
 * of these self-service endpoints yet.
 *
 * Languages has no per-row API — `PUT /testers/me/languages` replaces the
 * whole set — so each add/remove form carries the current list as a hidden
 * JSON snapshot and the Server Action recomputes the full array before
 * PUTting it. See the actions file for the detail.
 */
/**
 * A tester edits one thing at a time here — adds a device, corrects the
 * skill list, appends a job. Five forms in one column meant scrolling past
 * four of them to reach the fifth, and after a save the page returned to
 * the top. Tabs keep each form on its own screen.
 *
 * The NDA prompt stays above the tabs: it blocks assignment entirely, so it
 * is not something to find under a tab.
 */
const SECTIONS = [
  { value: 'about', label: 'About you', icon: 'user-check' },
  { value: 'devices', label: 'Devices', icon: 'smartphone' },
  { value: 'skills', label: 'Skills and languages', icon: 'briefcase' },
  { value: 'work', label: 'Work history', icon: 'clipboard-check' },
  { value: 'payment', label: 'Payment details', icon: 'credit-card' },
] as const

export default async function TesterProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>
}) {
  await requireRole(['TESTER'])

  const section = resolveSection(SECTIONS, (await searchParams).section)

  const [profile, catalog, paymentAccount] = await Promise.all([
    serverFetchOrNull<ProfileDetail>('testers/me'),
    serverFetchOrNull<Catalog>('catalog'),
    serverFetchOrNull<PaymentAccount | null>('payment-accounts/mine'),
  ])

  if (!profile) {
    return (
      <main id="main" style={{ maxWidth: 720, margin: '0 auto', padding: 'var(--space-9)' }}>
        <p style={{ color: 'var(--text-secondary)' }}>
          Your profile could not be loaded. Refresh in a moment.
        </p>
      </main>
    )
  }

  const languagesJson = JSON.stringify(profile.languages.map((l) => ({ code: l.code, proficiency: l.proficiency })))
  const mySkillIds = new Set(profile.skills.map((s) => s.skill.id))
  const osVersionOptions = (catalog?.operatingSystems ?? []).flatMap((os) =>
    os.versions.map((v) => ({ value: v.id, label: `${os.name} ${v.version}` })),
  )
  const deviceModelOptions = (catalog?.deviceModels ?? []).map((m) => ({
    value: m.id,
    label: `${m.brand.name} ${m.name}`,
  }))

  return (
    <main
      id="main"
      style={{
        maxWidth: 840,
        margin: '0 auto',
        padding: 'var(--space-9) var(--space-7)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-7)',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <Link
          href="/app/tester"
          style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}
        >
          ← Back to your account
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            Your profile
          </h1>
          <StatusBadge status={profile.status} />
        </div>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          What projects see when deciding whether to invite you, and how we reach you.
        </p>
      </header>

      {!profile.ndaAcceptedAt ? (
        <Panel
          title="Accept the NDA"
          description="Required before you can be assigned to a project."
        >
          <form action={acceptNdaAction}>
            <Button type="submit" variant="primary" iconLeft="check">
              Accept the NDA
            </Button>
          </form>
        </Panel>
      ) : null}

      <SectionTabs basePath="/app/tester/profile" tabs={SECTIONS} active={section} />

      {section === 'about' ? (
        <>
          <Panel title="About you" description="Shown to project owners considering you for an invite.">
            <TrackedForm action={updateBasicInfoAction} style={FORM_STYLE}>
              <Field label="Headline" htmlFor="headline" hint="A one-line summary, up to 160 characters.">
                <Input id="headline" name="headline" maxLength={160} defaultValue={profile.headline ?? ''} />
              </Field>
              <Field label="Bio" htmlFor="bio">
                <Textarea id="bio" name="bio" rows={5} maxLength={4000} defaultValue={profile.bio ?? ''} />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-5)' }}>
                <Field label="Years of experience" htmlFor="experienceYears">
                  <Input
                    id="experienceYears"
                    name="experienceYears"
                    type="number"
                    min={0}
                    max={60}
                    defaultValue={profile.experienceYears ?? ''}
                  />
                </Field>
                <Field label="City" htmlFor="city">
                  <Input id="city" name="city" maxLength={120} defaultValue={profile.city ?? ''} />
                </Field>
                <Field label="Country" htmlFor="countryCode" hint="Two-letter code, e.g. IN.">
                  <Input
                    id="countryCode"
                    name="countryCode"
                    maxLength={2}
                    defaultValue={profile.countryCode ?? ''}
                    style={{ textTransform: 'uppercase' }}
                  />
                </Field>
              </div>
              <div>
                <Button type="submit" variant="primary">
                  Save
                </Button>
              </div>
            </TrackedForm>
          </Panel>
        </>
      ) : null}

      {section === 'devices' ? (
        <>
          <Panel title="Devices" description="What you can test on. Projects match testers by device coverage.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {profile.devices.length > 0 ? (
                <CardGrid min={260}>
                  {profile.devices.map((device) => (
                    <Card
                      key={device.id}
                      title={
                        <>
                          {[device.manufacturer, device.model].filter(Boolean).join(' ')}
                          {device.isPrimary ? (
                            <Badge tone="accent" uppercase={false} style={{ marginLeft: 'var(--space-2)' }}>
                              Primary
                            </Badge>
                          ) : null}
                        </>
                      }
                      meta={[
                        titleCase(device.type),
                        device.osName,
                        device.osVersion,
                        device.screenSize ? `${device.screenSize}"` : null,
                        device.ramGb ? `${device.ramGb} GB RAM` : null,
                        device.storageGb ? `${device.storageGb} GB storage` : null,
                        device.network,
                        device.browser,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      actions={
                        <form action={removeDeviceAction}>
                          <input type="hidden" name="deviceId" value={device.id} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            style={{ color: 'var(--status-error-fg)' }}
                          >
                            Remove
                          </Button>
                        </form>
                      }
                    />
                  ))}
                </CardGrid>
              ) : (
                <Muted>No devices added yet.</Muted>
              )}

              <TrackedForm
                action={addDeviceAction}
                style={{
                  ...FORM_STYLE,
                  paddingTop: 'var(--space-5)',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                {deviceModelOptions.length > 0 ? (
                  <Field
                    label="Known device model"
                    htmlFor="deviceModelId"
                    hint="Pick yours if it's listed — fills the brand in below. Not listed? Skip this and type the brand and model directly."
                  >
                    <Select
                      id="deviceModelId"
                      name="deviceModelId"
                      defaultValue=""
                      options={[{ value: '', label: "Not listed / I'll type it below" }, ...deviceModelOptions]}
                    />
                  </Field>
                ) : null}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-4)' }}>
                  <Field label="Type" htmlFor="type">
                    <Select
                      id="type"
                      name="type"
                      defaultValue="MOBILE"
                      options={DEVICE_TYPES.map((value) => ({ value, label: titleCase(value) }))}
                    />
                  </Field>
                  <Field label="Brand" htmlFor="manufacturer">
                    <Input id="manufacturer" name="manufacturer" maxLength={80} />
                  </Field>
                  <Field label="Model" htmlFor="model" required>
                    <Input id="model" name="model" required maxLength={120} placeholder="Pixel 7a" />
                  </Field>
                  <Field label="Screen size" htmlFor="screenSize">
                    <Input id="screenSize" name="screenSize" maxLength={40} placeholder="6.1 inch" />
                  </Field>
                  <Field label="RAM" htmlFor="ramGb">
                    <Input id="ramGb" name="ramGb" maxLength={20} placeholder="8 GB" />
                  </Field>
                  <Field label="Storage" htmlFor="storageGb">
                    <Input id="storageGb" name="storageGb" maxLength={20} placeholder="256 GB" />
                  </Field>
                </div>
                {osVersionOptions.length > 0 ? (
                  <Field
                    label="OS version"
                    htmlFor="osVersionRefId"
                    hint="Pick yours if it's listed. Not listed? Skip this and type it below instead."
                  >
                    <Select
                      id="osVersionRefId"
                      name="osVersionRefId"
                      defaultValue=""
                      options={[{ value: '', label: "Not listed / I'll type it below" }, ...osVersionOptions]}
                    />
                  </Field>
                ) : null}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-4)' }}>
                  <Field label="OS name" htmlFor="osName">
                    <Input id="osName" name="osName" maxLength={60} placeholder="Android" />
                  </Field>
                  <Field label="OS version (typed)" htmlFor="osVersion">
                    <Input id="osVersion" name="osVersion" maxLength={40} placeholder="14" />
                  </Field>
                  <Field label="Network provider" htmlFor="primaryNetworkId">
                    <Select
                      id="primaryNetworkId"
                      name="primaryNetworkId"
                      defaultValue=""
                      options={[
                        { value: '', label: "Not listed" },
                        ...(catalog?.networks ?? []).map((n) => ({
                          value: n.id,
                          label: n.countryCode ? `${n.name} (${n.countryCode})` : n.name,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="Network (typed)" htmlFor="network">
                    <Input id="network" name="network" maxLength={80} placeholder="5G" />
                  </Field>
                  <Field label="Browser" htmlFor="browser">
                    <Input id="browser" name="browser" maxLength={80} placeholder="Chrome 128" />
                  </Field>
                </div>
                <Checkbox id="isPrimary" name="isPrimary" label="This is my primary device" />
                <div>
                  <Button type="submit" variant="secondary" iconLeft="plus">
                    Add device
                  </Button>
                </div>
              </TrackedForm>
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'skills' ? (
        <>
          <Panel
            title="Skills"
            description="Picked from the platform's skill catalog — saving replaces the full list. Don't see a skill you have? Ask an administrator to add it."
          >
            {catalog && catalog.skillCategories.length > 0 ? (
              <form action={setSkillsAction} style={FORM_STYLE}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
                  {catalog.skillCategories.map((category) => (
                    <div key={category.id}>
                      <p
                        className="c4t-eyebrow"
                        style={{ color: 'var(--text-muted)', margin: '0 0 var(--space-3)' }}
                      >
                        {category.name}
                      </p>
                      {category.skills.length === 0 ? (
                        <Muted>No skills in this category yet.</Muted>
                      ) : (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                            gap: 'var(--space-2) var(--space-4)',
                          }}
                        >
                          {category.skills.map((skill) => (
                            <Checkbox
                              key={skill.id}
                              id={`skill-${skill.id}`}
                              name="skillIds"
                              value={skill.id}
                              label={skill.name}
                              defaultChecked={mySkillIds.has(skill.id)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div>
                  <Button type="submit" variant="secondary">
                    Save skills
                  </Button>
                </div>
              </form>
            ) : (
              <Muted>The skill catalog is not reachable right now. Refresh in a moment.</Muted>
            )}
          </Panel>

          <Panel title="Languages">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {profile.languages.length > 0 ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', maxWidth: '40ch' }}>
                  {profile.languages.map((language) => (
                    <li
                      key={language.code}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 'var(--space-4)',
                        fontSize: 'var(--type-body-sm-size)',
                      }}
                    >
                      <span>
                        {language.code.toUpperCase()} · {titleCase(language.proficiency)}
                      </span>
                      <form action={removeLanguageAction}>
                        <input type="hidden" name="code" value={language.code} />
                        <input type="hidden" name="current" value={languagesJson} />
                        <Button type="submit" variant="ghost" size="sm" style={{ color: 'var(--status-error-fg)' }}>
                          Remove
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : (
                <Muted>No languages added yet.</Muted>
              )}

              <form
                action={addLanguageAction}
                style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}
              >
                <input type="hidden" name="current" value={languagesJson} />
                <Field label="Language code" htmlFor="code" hint="Two letters, e.g. en.">
                  <Input id="code" name="code" maxLength={2} style={{ width: 100 }} />
                </Field>
                <Field label="Proficiency" htmlFor="proficiency">
                  <Select
                    id="proficiency"
                    name="proficiency"
                    defaultValue="FLUENT"
                    options={PROFICIENCIES.map((value) => ({ value, label: titleCase(value) }))}
                  />
                </Field>
                <Button type="submit" variant="secondary" iconLeft="plus">
                  Add
                </Button>
              </form>
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'work' ? (
        <>
          <Panel title="Work history">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {profile.workHistory.length > 0 ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  {profile.workHistory.map((entry) => (
                    <li
                      key={entry.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 'var(--space-4)',
                        alignItems: 'center',
                        padding: 'var(--space-4)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-card)',
                        background: 'var(--surface-canvas)',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-primary)' }}>
                          {entry.jobTitle} · {entry.company}
                        </div>
                        <Muted>
                          {formatDate(entry.startDate)} – {entry.endDate ? formatDate(entry.endDate) : 'Present'}
                        </Muted>
                        {entry.description ? (
                          <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--type-body-sm-size)', color: 'var(--text-secondary)' }}>
                            {entry.description}
                          </p>
                        ) : null}
                      </div>
                      <form action={removeWorkHistoryAction}>
                        <input type="hidden" name="workHistoryId" value={entry.id} />
                        <Button type="submit" variant="ghost" size="sm" style={{ color: 'var(--status-error-fg)' }}>
                          Remove
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : (
                <Muted>No work history added yet.</Muted>
              )}

              <TrackedForm
                action={addWorkHistoryAction}
                style={{
                  ...FORM_STYLE,
                  paddingTop: 'var(--space-5)',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
                  <Field label="Company" htmlFor="company" required>
                    <Input id="company" name="company" required maxLength={160} />
                  </Field>
                  <Field label="Job title" htmlFor="jobTitle" required>
                    <Input id="jobTitle" name="jobTitle" required maxLength={160} />
                  </Field>
                  <Field label="Start date" htmlFor="startDate" required>
                    <Input id="startDate" name="startDate" type="date" required />
                  </Field>
                  <Field label="End date" htmlFor="endDate" hint="Leave blank if current.">
                    <Input id="endDate" name="endDate" type="date" />
                  </Field>
                </div>
                <Field label="Description" htmlFor="description">
                  <Textarea id="description" name="description" rows={3} maxLength={2000} />
                </Field>
                <div>
                  <Button type="submit" variant="secondary" iconLeft="plus">
                    Add role
                  </Button>
                </div>
              </TrackedForm>
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'payment' ? (
        <>
          <Panel
            title="Payment details"
            description="Where your earnings get paid out. Sensitive fields are encrypted — this page never shows the full account number back to you either, only what you'd need to confirm it's the right account."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {paymentAccount ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                    padding: 'var(--space-4)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--surface-canvas)',
                  }}
                >
                  <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-primary)' }}>
                    {PAYMENT_TYPE_LABEL[paymentAccount.paymentType as (typeof PAYMENT_TYPES)[number]] ??
                      titleCase(paymentAccount.paymentType)}
                  </div>
                  <Muted>
                    {[
                      paymentAccount.bankName,
                      paymentAccount.accountNumberLast4 ? `Account ending ${paymentAccount.accountNumberLast4}` : null,
                      paymentAccount.paypalEmailMasked,
                      paymentAccount.paytmNumberLast4 ? `Paytm ending ${paymentAccount.paytmNumberLast4}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Saved — details on file.'}
                  </Muted>
                </div>
              ) : (
                <Muted>No payment details on file yet.</Muted>
              )}

              <TrackedForm
                action={savePaymentAccountAction}
                style={{
                  ...FORM_STYLE,
                  paddingTop: 'var(--space-5)',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
                  <Field label="Country" htmlFor="country">
                    <Select
                      id="country"
                      name="country"
                      defaultValue={paymentAccount?.country ?? 'INDIAN'}
                      options={PAYMENT_COUNTRIES.map((value) => ({
                        value,
                        label: value === 'INDIAN' ? 'India' : 'Outside India',
                      }))}
                    />
                  </Field>
                  <Field label="Payout method" htmlFor="paymentType">
                    <Select
                      id="paymentType"
                      name="paymentType"
                      defaultValue={paymentAccount?.paymentType ?? 'IND_BANK_ACCOUNT'}
                      options={PAYMENT_TYPES.map((value) => ({
                        value,
                        label: PAYMENT_TYPE_LABEL[value],
                      }))}
                    />
                  </Field>
                </div>

                <p style={{ margin: 0, fontSize: 'var(--type-body-sm-size)', color: 'var(--text-muted)' }}>
                  Fill in the section below that matches your payout method above. Saving replaces
                  everything below in full, so re-enter every field even if you&rsquo;re only
                  changing one.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
                  <Field label="Account holder name" htmlFor="accountName">
                    <Input id="accountName" name="accountName" maxLength={255} />
                  </Field>
                  <Field label="Account number" htmlFor="accountNumber">
                    <Input id="accountNumber" name="accountNumber" maxLength={25} />
                  </Field>
                  <Field label="Bank name" htmlFor="bankName">
                    <Input id="bankName" name="bankName" maxLength={255} />
                  </Field>
                  <Field label="Branch name" htmlFor="branchName">
                    <Input id="branchName" name="branchName" maxLength={255} />
                  </Field>
                  <Field label="IFSC code" htmlFor="ifscCode" hint="Indian bank accounts only.">
                    <Input id="ifscCode" name="ifscCode" maxLength={25} style={{ textTransform: 'uppercase' }} />
                  </Field>
                  <Field label="PayPal email" htmlFor="paypalEmail">
                    <Input id="paypalEmail" name="paypalEmail" type="email" maxLength={255} />
                  </Field>
                  <Field label="Paytm number" htmlFor="paytmNumber">
                    <Input id="paytmNumber" name="paytmNumber" maxLength={10} />
                  </Field>
                </div>
                <div>
                  <Button type="submit" variant="primary">
                    Save payment details
                  </Button>
                </div>
              </TrackedForm>
            </div>
          </Panel>
        </>
      ) : null}

    </main>
  )
}

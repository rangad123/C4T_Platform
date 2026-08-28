import type { ReactNode } from 'react'
import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { DetailShell } from '@/components/admin/DetailShell'
import { Topbar } from '@/components/admin/Topbar'
import { Modal } from '@/components/admin/Modal'
import { Panel } from '@/components/admin/Panel'
import { SectionTabs, resolveSection } from '@/components/admin/SectionTabs'
import { Card, CardGrid } from '@/components/admin/Card'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Avatar } from '@/components/admin/Avatar'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { SingleFileUpload } from '@/components/admin/SingleFileUpload'
import { DownloadLink } from '@/components/tester/DownloadLink'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { formatDate, personName, titleCase } from '@/lib/admin/format'
import {
  updateBasicInfoAction,
  addDeviceAction,
  updateDeviceAction,
  removeDeviceAction,
  addBrowserAction,
  updateBrowserAction,
  removeBrowserAction,
  setSkillsAction,
  addLanguageAction,
  removeLanguageAction,
  addWorkHistoryAction,
  removeWorkHistoryAction,
  acceptNdaAction,
  savePaymentAccountAction,
  setNdaDocumentAction,
  setAvatarAction,
} from './actions'

const PROFILE_PATH = '/app/tester/profile'
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

/**
 * The three free-text-in-the-database fields the API stores verbatim.
 *
 * Offered as a fixed list here rather than an open input so the pool stays
 * filterable — the API column is a plain string precisely so this list can
 * grow without a migration, but a tester should not be inventing values.
 */
const AGE_GROUPS = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'] as const
const GENDERS = ['Female', 'Male', 'Non-binary', 'Other'] as const
const LOOKING_FOR = ['Part-time testing', 'Full-time testing', 'Freelance projects', 'Both'] as const

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
  gender: string | null
  ageGroup: string | null
  lookingFor: string | null
  skype: string | null
  linkedinUrl: string | null
  profession: string | null
  ndaAcceptedAt: string | null
  ndaFile: { id: string; originalName: string } | null
  user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    phone: string | null
    avatarFileId: string | null
  }
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

/** `GET /v1/settings/nda-template` — null until an admin uploads one. */
interface NdaTemplate {
  fileId: string
  name: string
}

/** A row of `GET /v1/catalog/me/browsers`. */
interface TesterBrowser {
  id: string
  createdAt: string
  browser: { id: string; name: string }
  browserVersion: { id: string; version: string } | null
  operatingSystem: { id: string; name: string; kind: string } | null
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
  browsers: readonly {
    id: string
    name: string
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

/** Fields that read as a row on a wide screen and stack on a narrow one. */
const FIELD_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 'var(--space-5)',
}

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
  { value: 'assets', label: 'Assets', icon: 'smartphone' },
  { value: 'skills', label: 'Skills and languages', icon: 'briefcase' },
  { value: 'work', label: 'Work history', icon: 'clipboard-check' },
  { value: 'payment', label: 'Payment details', icon: 'credit-card' },
] as const

/**
 * Work history has two halves and they are different kinds of thing: what you
 * have done ON this platform, and the CV you brought to it. They were one
 * undifferentiated list, which made the employment entries look like
 * Crowd4Test work.
 *
 * The reference design splits this Projects | Contests. Contests has no
 * backend — it is an out-of-scope module (see `api/docs/LEGACY-FEATURE-MAP.md`)
 * — so that tab is absent rather than present and empty.
 */
const WORK_VIEWS = [
  { value: 'projects', label: 'Projects' },
  { value: 'employment', label: 'Employment' },
] as const

type WorkView = (typeof WORK_VIEWS)[number]['value']

/** A row of `GET /v1/projects/my-assignments`, with this tester's own counts. */
interface AssignmentRow {
  status: string
  invitedAt: string
  respondedAt: string | null
  completedAt: string | null
  bugsReported: number
  bugsAccepted: number
  build: { id: string; name: string } | null
  project: {
    id: string
    reference: string
    title: string
    status: string
    startDate: string | null
    endDate: string | null
    organisation: { id: string; name: string } | null
  } | null
}

export default async function TesterProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; edit?: string; view?: string }>
}) {
  await requireRole(['TESTER'])

  const resolvedParams = await searchParams
  const section = resolveSection(SECTIONS, resolvedParams.section)
  /** Which half of Work history is showing. Defaults to platform projects. */
  const workView: WorkView = WORK_VIEWS.some((v) => v.value === resolvedParams.view)
    ? (resolvedParams.view as WorkView)
    : 'projects'

  const assignmentColumns: readonly TableColumn<AssignmentRow>[] = [
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project?.title ?? '—',
      renderSecondary: (row) =>
        [row.project?.reference, row.project?.organisation?.name, row.build?.name]
          .filter(Boolean)
          .join(' · '),
    },
    {
      key: 'assignment',
      header: 'Your standing',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'bugs',
      header: 'Bugs filed',
      align: 'right',
      /**
       * Accepted over reported, not a bare total: a tester's record is what
       * stood up to triage, and the two numbers together say more than either
       * alone. `ACCEPTED_BUG_STATUSES` on the API is the same definition the
       * profile header's own counter uses.
       */
      render: (row) => `${row.bugsAccepted} / ${row.bugsReported}`,
      renderSecondary: () => 'accepted / filed',
    },
    {
      key: 'joined',
      header: 'Joined',
      align: 'right',
      render: (row) => formatDate(row.respondedAt ?? row.invitedAt),
      renderSecondary: (row) => (row.completedAt ? `Finished ${formatDate(row.completedAt)}` : undefined),
    },
  ]
  /**
   * Which row's edit dialog is open, as `device:<id>` or `browser:<id>`.
   * URL-driven like every other modal in this app, so the open state
   * survives a refresh and a rejected save can reopen the same row.
   */
  const edit = resolvedParams.edit ?? ''

  // `profile` backs the header and the NDA banner on every section, so it
  // stays eager. `catalog` (device/OS/skill options) and `paymentAccount`
  // each back specific sections only — fetching them regardless of section
  // meant opening About or Work history waited on the full device/skill
  // catalog and the payout instrument for no reason.
  const [profile, catalog, paymentAccount, myBrowsers, ndaTemplate, assignments] = await Promise.all([
    serverFetchOrNull<ProfileDetail>('testers/me'),
    section === 'assets' || section === 'skills'
      ? serverFetchOrNull<Catalog>('catalog')
      : Promise.resolve(null),
    section === 'payment'
      ? serverFetchOrNull<PaymentAccount | null>('payment-accounts/mine')
      : Promise.resolve(null),
    // The tester's registered browsers. Same tab as devices, so it is gated
    // on the same section — and it is what populates the browser picker on
    // the bug-report form.
    section === 'assets'
      ? serverFetchOrNull<readonly TesterBrowser[]>('catalog/me/browsers')
      : Promise.resolve(null),
    // The blank NDA an admin has published, if any. Same tab as the NDA panel.
    section === 'about'
      ? serverFetchOrNull<NdaTemplate | null>('settings/nda-template')
      : Promise.resolve(null),
    // Platform work history. Only the Projects half of the Work tab needs it.
    section === 'work' && workView === 'projects'
      ? serverFetchOrNull<readonly AssignmentRow[]>('projects/my-assignments', {
          query: { limit: 100 },
        })
      : Promise.resolve(null),
  ])

  if (!profile) {
    return (
      <>
        <Topbar root={{ label: 'Tester', href: '/app/tester' }} crumbs={[{ label: 'Your profile' }]} />
        <main id="main" style={{ padding: 'var(--space-9)', maxWidth: 720 }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            Your profile could not be loaded. Refresh in a moment.
          </p>
        </main>
      </>
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
  const browserOptions = (catalog?.browsers ?? []).map((b) => ({ value: b.id, label: b.name }))
  /**
   * Every version across every browser, one flat list.
   *
   * A cascading "pick a browser, then its versions" needs client state, and
   * this page is deliberately server-rendered throughout. Prefixing each
   * version with its browser name keeps the flat list unambiguous — "Chrome
   * 128" reads correctly even sitting next to "Firefox 128".
   */
  const browserVersionOptions = (catalog?.browsers ?? []).flatMap((b) =>
    b.versions.map((v) => ({ value: v.id, label: `${b.name} ${v.version}` })),
  )
  const osOptions = (catalog?.operatingSystems ?? []).map((os) => ({
    value: os.id,
    label: os.name,
  }))

  return (
    <DetailShell
      root={{ label: 'Tester', href: '/app/tester' }}
      crumbs={[{ label: 'Your profile' }]}
      eyebrow="Account"
      title="Your profile"
      badges={<StatusBadge status={profile.status} />}
      subtitle="What projects see when deciding whether to invite you, and how we reach you."
      tabs={<SectionTabs basePath="/app/tester/profile" tabs={SECTIONS} active={section} />}
    >
      {!profile.ndaAcceptedAt ? (
        <Panel
          title="Accept the NDA"
          description="Required before you can be assigned to a project."
        >
          <form action={acceptNdaAction}>
            <SubmitButton variant="primary" iconLeft="check" pendingLabel="Accepting…">
              Accept the NDA
            </SubmitButton>
          </form>
        </Panel>
      ) : null}

      {section === 'about' ? (
        <>
          <Panel
            title="Profile picture"
            description="Shown next to your name on projects you work on."
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', flexWrap: 'wrap' }}>
              <Avatar
                name={personName(profile.user)}
                fileId={profile.user.avatarFileId}
                size="xl"
              />
              <SingleFileUpload
                endpoint="/app/tester/upload"
                scope="avatar"
                accept="image/png,image/jpeg,image/webp,image/gif"
                label="Upload a picture"
                onUploaded={setAvatarAction}
              />
            </div>
          </Panel>

          <Panel title="About you" description="Shown to project owners considering you for an invite.">
            <TrackedForm action={updateBasicInfoAction} style={FORM_STYLE}>
              <div style={FIELD_GRID}>
                <Field label="First name" htmlFor="firstName" required>
                  <Input
                    id="firstName"
                    name="firstName"
                    required
                    maxLength={80}
                    autoComplete="given-name"
                    defaultValue={profile.user.firstName ?? ''}
                  />
                </Field>
                <Field label="Last name" htmlFor="lastName">
                  <Input
                    id="lastName"
                    name="lastName"
                    maxLength={80}
                    autoComplete="family-name"
                    defaultValue={profile.user.lastName ?? ''}
                  />
                </Field>
              </div>

              <Field label="Headline" htmlFor="headline" hint="A one-line summary, up to 160 characters.">
                <Input id="headline" name="headline" maxLength={160} defaultValue={profile.headline ?? ''} />
              </Field>
              <Field label="Bio" htmlFor="bio">
                <Textarea id="bio" name="bio" rows={5} maxLength={4000} defaultValue={profile.bio ?? ''} />
              </Field>

              <div style={FIELD_GRID}>
                <Field label="Age group" htmlFor="ageGroup">
                  <Select
                    id="ageGroup"
                    name="ageGroup"
                    defaultValue={profile.ageGroup ?? ''}
                    options={[{ value: '', label: 'Prefer not to say' }, ...AGE_GROUPS.map((v) => ({ value: v, label: v }))]}
                  />
                </Field>
                <Field label="Gender" htmlFor="gender">
                  <Select
                    id="gender"
                    name="gender"
                    defaultValue={profile.gender ?? ''}
                    options={[{ value: '', label: 'Prefer not to say' }, ...GENDERS.map((v) => ({ value: v, label: v }))]}
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

              <div style={FIELD_GRID}>
                <Field label="Email" htmlFor="email" hint="Changing this is not self-service — contact support.">
                  <Input id="email" name="email" defaultValue={profile.user.email} disabled />
                </Field>
                <Field label="Phone" htmlFor="phone">
                  <Input
                    id="phone"
                    name="phone"
                    type="tel"
                    maxLength={32}
                    autoComplete="tel"
                    defaultValue={profile.user.phone ?? ''}
                  />
                </Field>
                <Field label="Skype" htmlFor="skype">
                  <Input id="skype" name="skype" maxLength={120} defaultValue={profile.skype ?? ''} />
                </Field>
                <Field label="LinkedIn" htmlFor="linkedinUrl" hint="Full URL, or leave blank.">
                  <Input
                    id="linkedinUrl"
                    name="linkedinUrl"
                    type="url"
                    maxLength={255}
                    placeholder="https://www.linkedin.com/in/…"
                    defaultValue={profile.linkedinUrl ?? ''}
                  />
                </Field>
              </div>

              <div style={FIELD_GRID}>
                <Field label="Profession" htmlFor="profession">
                  <Input
                    id="profession"
                    name="profession"
                    maxLength={120}
                    placeholder="Software tester"
                    defaultValue={profile.profession ?? ''}
                  />
                </Field>
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
                <Field label="Looking for" htmlFor="lookingFor">
                  <Select
                    id="lookingFor"
                    name="lookingFor"
                    defaultValue={profile.lookingFor ?? ''}
                    options={[{ value: '', label: 'Not saying' }, ...LOOKING_FOR.map((v) => ({ value: v, label: v }))]}
                  />
                </Field>
              </div>

              <div>
                <SubmitButton variant="primary" pendingLabel="Saving…">
                  Save changes
                </SubmitButton>
              </div>
            </TrackedForm>
          </Panel>

          <Panel
            title="Non-disclosure agreement"
            description="Projects share unreleased builds with you. The NDA is what makes that possible."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <DescriptionList
                items={[
                  {
                    label: 'Status',
                    value: profile.ndaAcceptedAt ? (
                      <Badge tone="success" uppercase={false}>
                        Accepted {formatDate(profile.ndaAcceptedAt)}
                      </Badge>
                    ) : (
                      <Badge tone="warning" uppercase={false}>
                        Not accepted
                      </Badge>
                    ),
                  },
                  {
                    label: 'Signed copy',
                    value: profile.ndaFile ? (
                      <DownloadLink fileId={profile.ndaFile.id} name={profile.ndaFile.originalName} />
                    ) : (
                      'Not uploaded'
                    ),
                  },
                ]}
              />

              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)', maxWidth: '70ch' }}>
                Accepting online is enough to be assigned to a project. Uploading a signed PDF is
                only needed when a project asks for a countersigned copy.
              </p>

              {/* Only rendered once an operator has published a blank NDA. No
                  placeholder when there is none: a link that downloads nothing
                  is worse than no link. */}
              {ndaTemplate ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  <Muted>Blank copy to print and sign</Muted>
                  <DownloadLink fileId={ndaTemplate.fileId} name={ndaTemplate.name} />
                </div>
              ) : null}

              <SingleFileUpload
                endpoint="/app/tester/upload"
                scope="nda"
                accept="application/pdf"
                label={profile.ndaFile ? 'Replace signed NDA' : 'Upload signed NDA'}
                onUploaded={setNdaDocumentAction}
                currentName={profile.ndaFile?.originalName ?? null}
              />
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'assets' ? (
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
                        <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                          <Button
                            href={`${PROFILE_PATH}?section=assets&edit=device:${device.id}`}
                            variant="ghost"
                            size="sm"
                            iconLeft="pencil"
                          >
                            Edit
                          </Button>
                          <form action={removeDeviceAction}>
                            <input type="hidden" name="deviceId" value={device.id} />
                            <ConfirmSubmit question={`Remove ${device.model}?`}>
                              Remove
                            </ConfirmSubmit>
                          </form>
                        </span>
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
                  <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Adding…">
                    Add device
                  </SubmitButton>
                </div>
              </TrackedForm>
            </div>
          </Panel>

          {/* One dialog per device, opened by `?edit=device:<id>`. */}
          {profile.devices.map((device) => (
            <Modal
              key={`edit-${device.id}`}
              open={edit === `device:${device.id}`}
              closedHref={`${PROFILE_PATH}?section=assets`}
              title="Edit device"
            >
              <TrackedForm action={updateDeviceAction} style={FORM_STYLE}>
                <input type="hidden" name="deviceId" value={device.id} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-4)' }}>
                  <Field label="Type" htmlFor={`type-${device.id}`}>
                    <Select
                      id={`type-${device.id}`}
                      name="type"
                      defaultValue={device.type}
                      options={DEVICE_TYPES.map((value) => ({ value, label: titleCase(value) }))}
                    />
                  </Field>
                  <Field label="Brand" htmlFor={`manufacturer-${device.id}`}>
                    <Input
                      id={`manufacturer-${device.id}`}
                      name="manufacturer"
                      maxLength={80}
                      defaultValue={device.manufacturer ?? ''}
                    />
                  </Field>
                  <Field label="Model" htmlFor={`model-${device.id}`} required>
                    <Input
                      id={`model-${device.id}`}
                      name="model"
                      required
                      maxLength={120}
                      defaultValue={device.model}
                    />
                  </Field>
                  <Field label="Screen size" htmlFor={`screenSize-${device.id}`}>
                    <Input
                      id={`screenSize-${device.id}`}
                      name="screenSize"
                      maxLength={40}
                      defaultValue={device.screenSize ?? ''}
                    />
                  </Field>
                  <Field label="RAM" htmlFor={`ramGb-${device.id}`}>
                    <Input
                      id={`ramGb-${device.id}`}
                      name="ramGb"
                      maxLength={20}
                      defaultValue={device.ramGb ?? ''}
                    />
                  </Field>
                  <Field label="Storage" htmlFor={`storageGb-${device.id}`}>
                    <Input
                      id={`storageGb-${device.id}`}
                      name="storageGb"
                      maxLength={20}
                      defaultValue={device.storageGb ?? ''}
                    />
                  </Field>
                  <Field label="OS name" htmlFor={`osName-${device.id}`}>
                    <Input
                      id={`osName-${device.id}`}
                      name="osName"
                      maxLength={60}
                      defaultValue={device.osName ?? ''}
                    />
                  </Field>
                  <Field label="OS version" htmlFor={`osVersion-${device.id}`}>
                    <Input
                      id={`osVersion-${device.id}`}
                      name="osVersion"
                      maxLength={40}
                      defaultValue={device.osVersion ?? ''}
                    />
                  </Field>
                  <Field label="Network" htmlFor={`network-${device.id}`}>
                    <Input
                      id={`network-${device.id}`}
                      name="network"
                      maxLength={80}
                      defaultValue={device.network ?? ''}
                    />
                  </Field>
                  <Field label="Browser" htmlFor={`browser-${device.id}`}>
                    <Input
                      id={`browser-${device.id}`}
                      name="browser"
                      maxLength={80}
                      defaultValue={device.browser ?? ''}
                    />
                  </Field>
                </div>
                <Checkbox
                  id={`isPrimary-${device.id}`}
                  name="isPrimary"
                  defaultChecked={device.isPrimary}
                  label="This is my primary device"
                />
                <div>
                  <SubmitButton variant="primary" pendingLabel="Saving…">
                    Save device
                  </SubmitButton>
                </div>
              </TrackedForm>
            </Modal>
          ))}

          {/* ── Browsers ──────────────────────────────────────────────── */}
          <Panel
            title="Browsers"
            description="The browsers you can test on. These are what the bug-report form offers you when recording where you saw a defect."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {myBrowsers === null ? (
                <Muted>Your browsers could not be loaded. Refresh in a moment.</Muted>
              ) : myBrowsers.length > 0 ? (
                <CardGrid min={240}>
                  {myBrowsers.map((row) => (
                    <Card
                      key={row.id}
                      title={[row.browser.name, row.browserVersion?.version].filter(Boolean).join(' ')}
                      meta={row.operatingSystem?.name ?? 'Any operating system'}
                      actions={
                        <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                          <Button
                            href={`${PROFILE_PATH}?section=assets&edit=browser:${row.id}`}
                            variant="ghost"
                            size="sm"
                            iconLeft="pencil"
                          >
                            Edit
                          </Button>
                          <form action={removeBrowserAction}>
                            <input type="hidden" name="browserRowId" value={row.id} />
                            <ConfirmSubmit
                              question={`Remove ${row.browser.name}${row.browserVersion ? ` ${row.browserVersion.version}` : ''}?`}
                            >
                              Remove
                            </ConfirmSubmit>
                          </form>
                        </span>
                      }
                    />
                  ))}
                </CardGrid>
              ) : (
                <Muted>No browsers added yet.</Muted>
              )}

              {browserOptions.length === 0 ? (
                <Muted>The browser catalog is not reachable right now. Refresh in a moment.</Muted>
              ) : (
                <TrackedForm
                  action={addBrowserAction}
                  style={{
                    ...FORM_STYLE,
                    paddingTop: 'var(--space-5)',
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)' }}>
                    <Field label="Browser" htmlFor="browserId" required>
                      <Select id="browserId" name="browserId" required placeholder="Choose a browser" options={browserOptions} />
                    </Field>
                    <Field label="Version" htmlFor="browserVersionId" hint="Optional.">
                      <Select
                        id="browserVersionId"
                        name="browserVersionId"
                        defaultValue=""
                        options={[{ value: '', label: 'Any version' }, ...browserVersionOptions]}
                      />
                    </Field>
                    <Field label="Operating system" htmlFor="operatingSystemId" hint="Optional.">
                      <Select
                        id="operatingSystemId"
                        name="operatingSystemId"
                        defaultValue=""
                        options={[{ value: '', label: 'Any operating system' }, ...osOptions]}
                      />
                    </Field>
                  </div>
                  <div>
                    <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Adding…">
                      Add browser
                    </SubmitButton>
                  </div>
                </TrackedForm>
              )}
            </div>
          </Panel>

          {(myBrowsers ?? []).map((row) => (
            <Modal
              key={`edit-browser-${row.id}`}
              open={edit === `browser:${row.id}`}
              closedHref={`${PROFILE_PATH}?section=assets`}
              title="Edit browser"
            >
              <TrackedForm action={updateBrowserAction} style={FORM_STYLE}>
                <input type="hidden" name="browserRowId" value={row.id} />
                <Field label="Browser" htmlFor={`browserId-${row.id}`} required>
                  <Select
                    id={`browserId-${row.id}`}
                    name="browserId"
                    required
                    defaultValue={row.browser.id}
                    options={browserOptions}
                  />
                </Field>
                <Field label="Version" htmlFor={`browserVersionId-${row.id}`} hint="Optional.">
                  <Select
                    id={`browserVersionId-${row.id}`}
                    name="browserVersionId"
                    defaultValue={row.browserVersion?.id ?? ''}
                    options={[{ value: '', label: 'Any version' }, ...browserVersionOptions]}
                  />
                </Field>
                <Field label="Operating system" htmlFor={`operatingSystemId-${row.id}`} hint="Optional.">
                  <Select
                    id={`operatingSystemId-${row.id}`}
                    name="operatingSystemId"
                    defaultValue={row.operatingSystem?.id ?? ''}
                    options={[{ value: '', label: 'Any operating system' }, ...osOptions]}
                  />
                </Field>
                <div>
                  <SubmitButton variant="primary" pendingLabel="Saving…">
                    Save browser
                  </SubmitButton>
                </div>
              </TrackedForm>
            </Modal>
          ))}
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
                  <SubmitButton variant="secondary" pendingLabel="Saving…">
                    Save skills
                  </SubmitButton>
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
                        <ConfirmSubmit
                          iconLeft=""
                          question={`Remove ${language.code.toUpperCase()}?`}
                        >
                          Remove
                        </ConfirmSubmit>
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
                <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Adding…">
                  Add
                </SubmitButton>
              </form>
            </div>
          </Panel>
        </>
      ) : null}

      {section === 'work' ? (
        <>
          {/* Sub-tabs, not a second SectionTabs strip: this is a switch inside
              one tab, so it is styled as a segmented control rather than
              competing with the tab row above it. */}
          <nav
            aria-label="Work history view"
            style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
          >
            {WORK_VIEWS.map((view) => {
              const active = view.value === workView
              return (
                <Button
                  key={view.value}
                  href={`${PROFILE_PATH}?section=work&view=${view.value}`}
                  variant={active ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-current={active ? 'page' : undefined}
                >
                  {view.label}
                </Button>
              )
            })}
          </nav>

          {workView === 'projects' ? (
            <Panel
              title="Projects you have worked on"
              description="Every project you were invited to, and what you filed on it."
            >
              {assignments === null ? (
                <Muted>Your project history could not be loaded. Refresh in a moment.</Muted>
              ) : assignments.length === 0 ? (
                <EmptyState
                  icon="briefcase"
                  title="No project work yet"
                  description="Once you are invited to a project it will appear here with what you reported on it."
                />
              ) : (
                <Table
                  columns={assignmentColumns}
                  rows={[...assignments].filter((a) => a.project !== null)}
                  rowKey={(row) => row.project!.id}
                  rowHref={(row) => `/app/tester/projects/${row.project!.id}`}
                />
              )}
            </Panel>
          ) : null}

          {workView !== 'employment' ? null : (
          <Panel title="Employment history" description="The roles you brought with you.">
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
                        <ConfirmSubmit
                          iconLeft=""
                          question={`Remove ${entry.jobTitle} at ${entry.company}?`}
                        >
                          Remove
                        </ConfirmSubmit>
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
                  <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Adding…">
                    Add role
                  </SubmitButton>
                </div>
              </TrackedForm>
            </div>
          </Panel>
          )}
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
                  <SubmitButton variant="primary" pendingLabel="Saving…">
                    Save payment details
                  </SubmitButton>
                </div>
              </TrackedForm>
            </div>
          </Panel>
        </>
      ) : null}
    </DetailShell>
  )
}

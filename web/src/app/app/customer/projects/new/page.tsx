import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { MultiSelect } from '@/components/admin/MultiSelect'
import { InlineFileUpload } from '@/components/admin/InlineFileUpload'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { countryOptions, languageOptions } from '@/lib/admin/locales'
import { createProjectFromWizard } from './actions'
import { FormBackButton } from './BackButton'

const ROOT = { label: 'Customer', href: '/app/customer' }
const BASE = '/app/customer/projects/new'
const UPLOAD = '/app/customer/upload'

/**
 * `/app/customer/projects/new` — the reference product's project wizard.
 *
 * ── WHY STATE LIVES IN THE URL
 *
 * The reference is a four-part flow, and the brief is explicit that moving
 * Previous → Next → Previous must not lose anything. Holding the whole thing
 * in one big client component would satisfy that until the first refresh.
 * Instead each step is an ordinary form that navigates to the next step
 * carrying everything entered so far, so the wizard is refresh-safe,
 * back-button-safe and linkable — and every step stays a Server Component.
 *
 * Files are the exception: bytes cannot ride along in a query string, so
 * `InlineFileUpload` stores them the moment they are picked and only the
 * resulting id travels between steps. See that component for the trade-off.
 *
 * ── WHAT THE BACKEND ALREADY DOES
 *
 * Nothing here needed a new endpoint. `POST /projects` takes the project-level
 * fields and creates the first build; `PATCH /projects/:id/builds/:buildId`
 * already accepts every build-level field this collects — app URL, test type,
 * test document, OS and browser targeting. The only schema addition this
 * feature required was the app logo. See `actions.ts` for the sequence.
 */

const STEPS = [
  { value: 'type', label: 'What to test' },
  { value: 'general', label: 'General settings' },
  { value: 'details', label: 'Scope' },
  { value: 'filters', label: 'Tester requirements' },
] as const

type Step = (typeof STEPS)[number]['value']

/** The kind of thing under test, from the reference's opening choice. */
const SUBJECTS = [
  {
    value: 'web',
    title: 'Website',
    description: 'A web app or site, tested in browsers.',
    icon: 'monitor',
  },
  {
    value: 'mobile',
    title: 'Mobile app',
    description: 'An Android or iOS build, tested on devices.',
    icon: 'smartphone',
  },
] as const

/**
 * Test types offered when the platform has no catalog for them.
 *
 * `Build.testType` is free text on purpose (see the schema note) — there is no
 * admin-managed list to read, so this is a starting vocabulary rather than a
 * constraint, and the field accepts anything the API's 120-character limit
 * allows.
 */
const TEST_TYPES = [
  'Exploratory testing',
  'Functional testing',
  'Usability testing',
  'Regression testing',
  'Compatibility testing',
  'Performance testing',
  'Security testing',
  'Localization testing',
  'Accessibility testing',
] as const

const ERRORS: Record<string, NoticeCopy> = {
  title: { tone: 'error', message: 'Give the test a title of at least three characters.' },
  build: { tone: 'error', message: 'Enter a build version.' },
  url: {
    tone: 'error',
    message: 'Enter the full link to your app, starting with http:// or https://.',
  },
  participants: { tone: 'error', message: 'Enter how many testers you want, as a whole number.' },
  dates: { tone: 'error', message: 'Choose both a start and an end date.' },
  range: { tone: 'error', message: 'The test cannot end before it starts.' },
  instructions: {
    tone: 'error',
    message: 'Describe the testing to be done — testers work from this.',
  },
  invalid: {
    tone: 'error',
    message: 'Some values were not accepted. Check the fields on this step.',
  },
  failed: { tone: 'error', message: 'The project could not be created. Try again in a moment.' },
  'no-org': {
    tone: 'error',
    message:
      'Your account is not linked to an organisation yet, so there is nothing to create the project under. Contact your account manager to get set up.',
  },
  'many-orgs': {
    tone: 'error',
    message:
      'Your account belongs to more than one organisation, so we cannot tell which should own this project. Contact your account manager.',
  },
  duplicate: {
    tone: 'error',
    message: 'A project with that title already exists. Choose a different title.',
  },
}

interface CatalogShape {
  operatingSystems: readonly { id: string; name: string; kind: string }[]
  browsers: readonly { id: string; name: string }[]
}

/** Every value the wizard accumulates, as it arrives from the URL. */
interface WizardParams {
  step?: string
  error?: string
  subject?: string
  title?: string
  buildName?: string
  appUrl?: string
  maxTesters?: string
  startDate?: string
  endDate?: string
  logoFileId?: string
  logoFileName?: string
  testType?: string
  testDocumentFileId?: string
  testDocumentFileName?: string
  instructions?: string
  specialRequirements?: string
  /* Repeated in the query — one entry per chip — so Next hands these over as
     arrays whenever more than one is chosen. */
  targetCountries?: string | string[]
  targetLanguages?: string | string[]
  targetOperatingSystems?: string | string[]
  targetBrowsers?: string | string[]
}

/** A repeated query parameter, always as a list. */
function readMulti(value: string | string[] | undefined): string[] {
  if (!value) return []
  return (Array.isArray(value) ? value : [value]).filter(Boolean)
}

/** Carries a value forward as a hidden field on the next step's form. */
function Carry({ name, value }: { name: string; value: string | undefined }) {
  if (!value) return null
  return <input type="hidden" name={name} value={value} />
}

/**
 * Carries a multi-value filter forward — one hidden input per entry, which is
 * how `MultiSelect` itself emits them and how the API expects to receive them.
 *
 * Without this, stepping back past the final step and forward again would
 * quietly empty the tester filters: the earlier steps' forms only post the
 * fields they render, and they do not render these.
 */
function CarryAll({ name, values }: { name: string; values: readonly string[] }) {
  return (
    <>
      {values.map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}
    </>
  )
}

/** The four tester filters, for the steps that only pass them through. */
function CarryFilters({ params }: { params: WizardParams }) {
  return (
    <>
      <CarryAll name="targetCountries" values={readMulti(params.targetCountries)} />
      <CarryAll name="targetLanguages" values={readMulti(params.targetLanguages)} />
      <CarryAll name="targetOperatingSystems" values={readMulti(params.targetOperatingSystems)} />
      <CarryAll name="targetBrowsers" values={readMulti(params.targetBrowsers)} />
    </>
  )
}

/** A link back to an earlier step with everything entered so far intact. */
function stepHref(step: Step, params: WizardParams): string {
  const query = new URLSearchParams()
  query.set('step', step)
  for (const [key, value] of Object.entries(params)) {
    if (key === 'step' || key === 'error' || !value) continue
    /* `set(key, String(list))` would collapse a multi-value filter into one
       comma-joined string, which is not what it came in as. */
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry) query.append(key, entry)
    }
  }
  return `${BASE}?${query.toString()}`
}

const FORM_STYLE = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-5)',
}

const FIELD_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 'var(--space-5)',
}

export default async function NewProjectWizardPage({
  searchParams,
}: {
  searchParams: Promise<WizardParams>
}) {
  await requireRole(['CUSTOMER'])
  const params = await searchParams

  const step: Step = STEPS.some((s) => s.value === params.step) ? (params.step as Step) : 'type'
  /**
   * `findIndex` cannot miss — `step` is only ever one of `STEPS` — but it is
   * typed as possibly -1, so the current step is resolved by lookup instead
   * and the index derived from it.
   */
  const current = STEPS.find((s) => s.value === step) ?? STEPS[0]
  const stepIndex = STEPS.indexOf(current)

  /**
   * OS and browser choices come from the platform's own catalog — §71: the
   * client consumes what an admin configured rather than a second hardcoded
   * list. Only the tester-requirements step needs it.
   */
  const catalog = step === 'filters' ? await serverFetchOrNull<CatalogShape>('catalog') : null

  const osOptions = (catalog?.operatingSystems ?? []).map((os) => ({
    value: os.name,
    label: os.name,
  }))
  const browserOptions = (catalog?.browsers ?? []).map((b) => ({
    value: b.name,
    label: b.name,
  }))

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Projects', href: '/app/customer/projects' }, { label: 'New test' }]}
      eyebrow="Delivery"
      title="Set up a test"
      subtitle={`Step ${stepIndex + 1} of ${STEPS.length} — ${current.label}.`}
    >
      <Notice code={params.error} notices={ERRORS} param="error" />

      {/* Progress. A list rather than decoration, so a screen reader can hear
          where it is; completed steps link back, later ones do not. */}
      <nav aria-label="Progress">
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
          }}
        >
          {STEPS.map((s, i) => {
            const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo'
            const body = (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  height: 32,
                  padding: '0 var(--space-4)',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 'var(--type-body-sm-size)',
                  fontWeight: state === 'current' ? 'var(--fw-semibold)' : 'var(--fw-medium)',
                  background: state === 'current' ? 'var(--surface-sunken)' : 'transparent',
                  border: `1px solid ${
                    state === 'todo' ? 'var(--border-subtle)' : 'var(--border-default)'
                  }`,
                  color: state === 'todo' ? 'var(--text-muted)' : 'var(--text-primary)',
                }}
              >
                {i + 1}. {s.label}
              </span>
            )
            return (
              <li key={s.value} aria-current={state === 'current' ? 'step' : undefined}>
                {state === 'done' ? (
                  <a href={stepHref(s.value, params)} style={{ textDecoration: 'none' }}>
                    {body}
                  </a>
                ) : (
                  body
                )}
              </li>
            )
          })}
        </ol>
      </nav>

      {/* ── Step 1: what is under test ──────────────────────────────────── */}
      {step === 'type' ? (
        <Panel
          title="What do you want to test?"
          description="This sets the kind of test and who can take it."
        >
          <div style={FIELD_GRID}>
            {SUBJECTS.map((subject) => (
              <form key={subject.value} method="get" action={BASE}>
                <input type="hidden" name="step" value="general" />
                <input type="hidden" name="subject" value={subject.value} />
                {/* Revisiting this step keeps everything already entered. */}
                <Carry name="title" value={params.title} />
                <Carry name="buildName" value={params.buildName} />
                <Carry name="appUrl" value={params.appUrl} />
                <Carry name="maxTesters" value={params.maxTesters} />
                <Carry name="startDate" value={params.startDate} />
                <Carry name="endDate" value={params.endDate} />
                <Carry name="logoFileId" value={params.logoFileId} />
                <Carry name="logoFileName" value={params.logoFileName} />
                <Carry name="testType" value={params.testType} />
                <Carry name="testDocumentFileId" value={params.testDocumentFileId} />
                <Carry name="testDocumentFileName" value={params.testDocumentFileName} />
                <Carry name="instructions" value={params.instructions} />
                <Carry name="specialRequirements" value={params.specialRequirements} />
                <CarryFilters params={params} />

                <button
                  type="submit"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 'var(--space-2)',
                    width: '100%',
                    padding: 'var(--space-6)',
                    textAlign: 'left',
                    borderRadius: 'var(--radius-card)',
                    border: `1px solid ${
                      params.subject === subject.value
                        ? 'var(--border-focus)'
                        : 'var(--border-default)'
                    }`,
                    background: 'var(--surface-canvas)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <span
                    style={{
                      fontSize: 'var(--type-body-md-size)',
                      fontWeight: 'var(--fw-semibold)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {subject.title}
                  </span>
                  <span
                    style={{
                      fontSize: 'var(--type-body-sm-size)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {subject.description}
                  </span>
                </button>
              </form>
            ))}
          </div>
        </Panel>
      ) : null}

      {/* ── Step 2: general settings ─────────────────────────────────────── */}
      {step === 'general' ? (
        <form method="get" action={BASE} style={FORM_STYLE}>
          <Carry name="subject" value={params.subject} />
          <CarryFilters params={params} />
          <Carry name="testType" value={params.testType} />
          <Carry name="testDocumentFileId" value={params.testDocumentFileId} />
          <Carry name="testDocumentFileName" value={params.testDocumentFileName} />
          <Carry name="instructions" value={params.instructions} />
          <Carry name="specialRequirements" value={params.specialRequirements} />

          <Panel
            title="General settings"
            description="The test, the build it covers, and when it runs."
          >
            <div style={FORM_STYLE}>
              <div style={FIELD_GRID}>
                <Field label="Test title" htmlFor="title" required>
                  <Input
                    id="title"
                    name="title"
                    required
                    minLength={3}
                    maxLength={200}
                    defaultValue={params.title ?? ''}
                    placeholder="Web app — checkout regression"
                  />
                </Field>
                <Field label="Build version" htmlFor="buildName" required>
                  <Input
                    id="buildName"
                    name="buildName"
                    required
                    maxLength={120}
                    defaultValue={params.buildName ?? ''}
                    placeholder="1.0.1"
                  />
                </Field>
              </div>

              {/*
               * Optional, matching the API — a build has never required an
               * appUrl. Mobile builds distributed as a file, and projects
               * scoped before a staging URL exists, were being turned away
               * by a rule only this form believed in.
               */}
              <Field
                label="Link to your app"
                htmlFor="appUrl"
                hint="The URL testers open, if there is one. Include http:// or https://."
              >
                <Input
                  id="appUrl"
                  name="appUrl"
                  type="url"
                  maxLength={2000}
                  defaultValue={params.appUrl ?? ''}
                  placeholder="https://staging.example.com"
                />
              </Field>

              <Field label="Logo of your app" htmlFor="logo">
                <InlineFileUpload
                  name="logoFileId"
                  endpoint={UPLOAD}
                  scope="project-logo"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  label="Upload a logo"
                  defaultFileId={params.logoFileId ?? ''}
                  defaultFileName={params.logoFileName ?? ''}
                  preview
                />
              </Field>
              {/* The name travels alongside the id so revisiting this step can
                  still say which file is attached. */}
              <Carry name="logoFileName" value={params.logoFileName} />

              <div style={FIELD_GRID}>
                <Field
                  label="Number of testers"
                  htmlFor="maxTesters"
                  required
                  hint="How many people you want on this test."
                >
                  <Input
                    id="maxTesters"
                    name="maxTesters"
                    type="number"
                    min={1}
                    max={10000}
                    required
                    defaultValue={params.maxTesters ?? ''}
                  />
                </Field>
                <Field label="Starts" htmlFor="startDate" required>
                  <Input
                    id="startDate"
                    name="startDate"
                    type="date"
                    required
                    defaultValue={params.startDate ?? ''}
                  />
                </Field>
                <Field label="Ends" htmlFor="endDate" required>
                  <Input
                    id="endDate"
                    name="endDate"
                    type="date"
                    required
                    defaultValue={params.endDate ?? ''}
                  />
                </Field>
              </div>
            </div>
          </Panel>

          <StepNav backStep="type" nextStep="details" nextLabel="Continue to scope" />
        </form>
      ) : null}

      {/* ── Step 3: scope ────────────────────────────────────────────────── */}
      {step === 'details' ? (
        <form method="get" action={BASE} style={FORM_STYLE}>
          <Carry name="subject" value={params.subject} />
          <CarryFilters params={params} />
          <Carry name="title" value={params.title} />
          <Carry name="buildName" value={params.buildName} />
          <Carry name="appUrl" value={params.appUrl} />
          <Carry name="maxTesters" value={params.maxTesters} />
          <Carry name="startDate" value={params.startDate} />
          <Carry name="endDate" value={params.endDate} />
          <Carry name="logoFileId" value={params.logoFileId} />
          <Carry name="logoFileName" value={params.logoFileName} />
          <Carry name="testDocumentFileName" value={params.testDocumentFileName} />

          <Panel
            title="Scope"
            description="What the testing covers, and anything testers must know first."
          >
            <div style={FORM_STYLE}>
              <Field label="Type of testing" htmlFor="testType">
                <Select
                  id="testType"
                  name="testType"
                  defaultValue={params.testType ?? ''}
                  options={[
                    { value: '', label: 'Not specified' },
                    ...TEST_TYPES.map((t) => ({ value: t, label: t })),
                  ]}
                />
              </Field>

              <Field
                label="Test document"
                htmlFor="testDocument"
                hint="Optional. Assigned testers can download this."
              >
                <InlineFileUpload
                  name="testDocumentFileId"
                  endpoint={UPLOAD}
                  scope="test-document"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
                  label="Upload a document"
                  defaultFileId={params.testDocumentFileId ?? ''}
                  defaultFileName={params.testDocumentFileName ?? ''}
                />
              </Field>

              <Field
                label="Describe the testing to be done"
                htmlFor="instructions"
                required
                hint="Testers read this before they start."
              >
                <Textarea
                  id="instructions"
                  name="instructions"
                  rows={6}
                  required
                  maxLength={20000}
                  defaultValue={params.instructions ?? ''}
                />
              </Field>

              <Field
                label="Special requirements"
                htmlFor="specialRequirements"
                hint="Optional. Accounts to use, areas to avoid, anything out of scope."
              >
                <Textarea
                  id="specialRequirements"
                  name="specialRequirements"
                  rows={4}
                  maxLength={4000}
                  defaultValue={params.specialRequirements ?? ''}
                />
              </Field>
            </div>
          </Panel>

          <StepNav
            backStep="general"
            nextStep="filters"
            nextLabel="Continue to tester requirements"
          />
        </form>
      ) : null}

      {/* ── Step 4: tester requirements, then submit ─────────────────────── */}
      {step === 'filters' ? (
        <form action={createProjectFromWizard} style={FORM_STYLE}>
          {/* Everything from the earlier steps, posted for real this time. */}
          <Carry name="title" value={params.title} />
          <Carry name="buildName" value={params.buildName} />
          <Carry name="appUrl" value={params.appUrl} />
          <Carry name="maxTesters" value={params.maxTesters} />
          <Carry name="startDate" value={params.startDate} />
          <Carry name="endDate" value={params.endDate} />
          <Carry name="logoFileId" value={params.logoFileId} />
          <Carry name="testType" value={params.testType} />
          <Carry name="testDocumentFileId" value={params.testDocumentFileId} />
          <Carry name="instructions" value={params.instructions} />
          <Carry name="specialRequirements" value={params.specialRequirements} />
          {/* The opening choice becomes the project's platform target. It is
              carried under its own name too, so stepping back from here knows
              which kind of thing is under test. */}
          <Carry name="platformTargets" value={params.subject} />
          <Carry name="subject" value={params.subject} />

          <Panel
            title="Who can take this test"
            description="These narrow the pool of testers eligible for the build. Leave a filter empty to place no limit on it."
          >
            <div style={FORM_STYLE}>
              <Field
                label="Countries"
                htmlFor="targetCountries"
                hint="Search and add. Leave empty for any country."
              >
                <MultiSelect
                  id="targetCountries"
                  name="targetCountries"
                  options={countryOptions()}
                  defaultValue={readMulti(params.targetCountries)}
                  placeholder="Search countries…"
                  max={60}
                />
              </Field>

              <Field
                label="Languages"
                htmlFor="targetLanguages"
                hint="Search and add. Leave empty for any language."
              >
                <MultiSelect
                  id="targetLanguages"
                  name="targetLanguages"
                  options={languageOptions()}
                  defaultValue={readMulti(params.targetLanguages)}
                  placeholder="Search languages…"
                  max={40}
                />
              </Field>

              <Field
                label="Operating systems"
                htmlFor="targetOperatingSystems"
                hint={
                  osOptions.length
                    ? 'From the platform device catalog.'
                    : 'The device catalog is unavailable right now — you can set this on the build afterwards.'
                }
              >
                <MultiSelect
                  id="targetOperatingSystems"
                  name="targetOperatingSystems"
                  options={osOptions}
                  defaultValue={readMulti(params.targetOperatingSystems)}
                  placeholder="Search operating systems…"
                  max={40}
                />
              </Field>

              <Field
                label="Browsers"
                htmlFor="targetBrowsers"
                hint={
                  browserOptions.length
                    ? 'From the platform browser catalog.'
                    : 'The browser catalog is unavailable right now — you can set this on the build afterwards.'
                }
              >
                <MultiSelect
                  id="targetBrowsers"
                  name="targetBrowsers"
                  options={browserOptions}
                  defaultValue={readMulti(params.targetBrowsers)}
                  placeholder="Search browsers…"
                  max={40}
                />
              </Field>
            </div>
          </Panel>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <FormBackButton action={BASE} step="details">
              Back
            </FormBackButton>
            {/* `SubmitButton` disables itself while in flight, which is what
                actually prevents a double submission. */}
            <SubmitButton variant="primary" pendingLabel="Creating project…">
              Create the project
            </SubmitButton>
          </div>
        </form>
      ) : null}
    </DetailShell>
  )
}

/**
 * Back and Next for the two middle steps.
 *
 * BOTH are submit buttons, and that is the point. Back was a plain link, which
 * navigated away without submitting — so anything typed on the current step
 * and not yet in the URL was silently lost, and coming forward again showed
 * empty fields. Two submits carrying different `step` values means going
 * backwards saves exactly as much as going forwards.
 *
 * Neither form has a hidden `step` field: only the clicked button's name/value
 * is submitted, so the two cannot both land and fight over which wins.
 */
function StepNav({
  backStep,
  nextStep,
  nextLabel,
}: {
  backStep: Step
  nextStep: Step
  nextLabel: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4)',
        flexWrap: 'wrap',
      }}
    >
      <SubmitButton name="step" value={backStep} variant="ghost" iconLeft="arrow-left">
        Back
      </SubmitButton>
      <SubmitButton name="step" value={nextStep} variant="primary" iconRight="arrow-right">
        {nextLabel}
      </SubmitButton>
    </div>
  )
}

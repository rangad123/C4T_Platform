import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { CustomFieldInput } from '@/components/tester/CustomFieldInput'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { EvidenceUpload } from '@/components/tester/EvidenceUpload'
import { EvidenceGuardedSubmit } from '@/components/tester/EvidenceGuardedSubmit'
import { titleCase } from '@/lib/admin/format'
import { reportBugAction } from '../actions'

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const REPRODUCIBILITIES = ['ALWAYS', 'SOMETIMES', 'RARELY', 'ONCE'] as const
const BUG_TYPES = [
  'CRASH',
  'APP_FREEZE',
  'FUNCTIONAL',
  'UI',
  'UX',
  'SECURITY',
  'PERFORMANCE',
] as const

/**
 * Statuses a project must NOT be in for the API to accept a report — mirrors
 * the service's own guard so the picker never offers a project that would be
 * rejected on submit.
 */
const CLOSED_TO_REPORTS: readonly string[] = ['DRAFT', 'COMPLETED', 'CANCELLED']

/** Assignment statuses that carry the right to file a bug (`bug.create`). */
const CAN_REPORT: readonly string[] = ['ACCEPTED', 'ACTIVE']

interface Assignment {
  status: string
  project: {
    id: string
    reference: string
    title: string
    status: string
  } | null
}

/** A row of `GET /v1/catalog/me/browsers` — what this tester actually runs. */
interface TesterBrowser {
  id: string
  browser: { id: string; name: string }
  browserVersion: { id: string; version: string } | null
  operatingSystem: { id: string; name: string; kind: string } | null
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid: 'Some fields were missing or too short. Check the title, description and steps.',
  evidence:
    'Attach a screenshot or recording, or paste a video link, before filing. A report nobody can see is a report nobody can act on.',
  'occurrence-pair':
    'Give both how many times it happened and how many attempts you made, or leave both blank.',
  'occurrence-range': 'It cannot have happened more times than you tried.',
  forbidden: 'You are not assigned to that project, so you cannot report against it.',
  missing: 'That project no longer exists.',
  closed: 'That project is not currently accepting bug reports.',
  failed: 'Could not file the report. Try again.',
}

/**
 * `/app/tester/bugs/new` — file a defect.
 *
 * The project picker is built from `/projects/my-assignments` filtered to
 * assignments that actually confer `bug.create` (ACCEPTED / ACTIVE) and to
 * projects in a status the API will accept. Filtering here is a UX courtesy,
 * not the security boundary — the API re-checks the relation on every
 * submit, which is what actually stops a hand-built post.
 */
/** A row of `GET /v1/projects/:id/custom-fields` — the client's extra questions. */
interface BugCustomField {
  id: string
  name: string
  type: string
  options: readonly string[]
  isRequired: boolean
}

export default async function NewTesterBugPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; projectId?: string; buildId?: string }>
}) {
  await requireRole(['TESTER'])
  const params = await searchParams
  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? ERROR_MESSAGES.failed)
    : null

  const assignments = await serverFetchOrNull<readonly Assignment[]>('projects/my-assignments')
  const reportable = (assignments ?? []).filter(
    (a) =>
      CAN_REPORT.includes(a.status) &&
      a.project !== null &&
      !CLOSED_TO_REPORTS.includes(a.project.status),
  )

  /**
   * Arriving from a build workspace ("Report a bug" on the project page)
   * carries the project and build in the URL, so the form opens already
   * pointed at what the tester was looking at. Landing here cold from the
   * sidebar leaves the picker on the first reportable project.
   *
   * The preselection is only honoured when it matches a project the tester
   * can actually report against — a hand-edited `?projectId=` for someone
   * else's project falls back rather than pre-filling a value the API will
   * refuse.
   */
  const preselected = reportable.find((a) => a.project?.id === params.projectId) ?? null
  const activeProjectId = preselected?.project?.id ?? reportable[0]?.project?.id ?? ''

  /**
   * Features and the tester's registered browsers make the report specific:
   * "sign up, on Chrome 128 / Windows 11" beats free-typed guesses. Both are
   * best-effort — a failure leaves the fields as plain inputs rather than
   * blocking the report, because an unfiled bug is worse than an unlabelled
   * one.
   */
  const [features, myBrowsers, customFields] = await Promise.all([
    activeProjectId
      ? serverFetchOrNull<readonly { id: string; name: string }[]>(
          `projects/${activeProjectId}/features`,
          params.buildId ? { query: { buildId: params.buildId } } : undefined,
        )
      : Promise.resolve(null),
    serverFetchOrNull<readonly TesterBrowser[]>('catalog/me/browsers'),
    /**
     * The client's own extra questions for this build (§72).
     *
     * Best-effort like the rest of this block: if it fails the form still
     * submits, because the API re-checks required answers against the build's
     * definitions anyway and an unfiled bug is worse than one missing an
     * optional field. Returns nothing when customisation is switched off.
     */
    activeProjectId
      ? serverFetchOrNull<readonly BugCustomField[]>(
          `projects/${activeProjectId}/custom-fields`,
          params.buildId ? { query: { buildId: params.buildId } } : undefined,
        )
      : Promise.resolve(null),
  ])

  const browserOptions = (myBrowsers ?? []).map((b) => {
    const label = [
      b.operatingSystem?.name,
      b.browser.name,
      b.browserVersion?.version,
    ]
      .filter(Boolean)
      .join(' · ')
    return { value: label, label }
  })

  return (
    <DetailShell
      root={{ label: 'Tester', href: '/app/tester' }}
      crumbs={[{ label: 'Bugs', href: '/app/tester/bugs' }, { label: 'Report a bug' }]}
      eyebrow="Work"
      title="Report a bug"
      subtitle="Write the steps so someone who has never seen the problem can reproduce it. That is the difference between a report that gets fixed and one that gets sent back."
    >
      {errorMessage ? (
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
          {errorMessage}
        </p>
      ) : null}

      {reportable.length === 0 ? (
        <EmptyState
          icon="clipboard-check"
          title="No project to report against"
          description="You can file a bug once you have accepted an invitation to a project that is still running."
        />
      ) : (
        <TrackedForm
          action={reportBugAction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
        >
          <Panel title="What and where">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {/*
                Carried through untouched when the form was opened from a
                build workspace, so the report lands on the build the tester
                was actually looking at rather than the project's default.
                The API re-resolves it and refuses a build that isn't on the
                named project.
              */}
              {params.buildId ? <input type="hidden" name="buildId" value={params.buildId} /> : null}

              <Field label="Project" htmlFor="projectId" required>
                <Select
                  id="projectId"
                  name="projectId"
                  required
                  defaultValue={activeProjectId}
                  options={reportable.map((a) => ({
                    value: a.project!.id,
                    label: `${a.project!.reference} — ${a.project!.title}`,
                  }))}
                />
              </Field>

              {features && features.length > 0 ? (
                <Field
                  label="Feature"
                  htmlFor="featureId"
                  hint="Which part of the product this is in. Tagging it means the team can see where defects cluster."
                >
                  <Select
                    id="featureId"
                    name="featureId"
                    defaultValue=""
                    options={[
                      { value: '', label: 'Not sure' },
                      ...features.map((f) => ({ value: f.id, label: f.name })),
                    ]}
                  />
                </Field>
              ) : null}

              <Field
                label="Title"
                htmlFor="title"
                required
                hint="One line, at least 5 characters. Say what breaks, not that something breaks."
              >
                <Input
                  id="title"
                  name="title"
                  required
                  minLength={5}
                  maxLength={200}
                  placeholder="Checkout hangs after entering the UPI PIN"
                />
              </Field>

              <Field
                label="Description"
                htmlFor="description"
                required
                hint="At least 10 characters."
              >
                <Textarea id="description" name="description" rows={4} required minLength={10} maxLength={10000} />
              </Field>

              <Field
                label="Pre-condition"
                htmlFor="preCondition"
                hint="The state the app had to be in before your steps begin — signed in as a returning customer, one item already in the cart. Setup, not a step."
              >
                <Textarea id="preCondition" name="preCondition" rows={2} maxLength={4000} />
              </Field>

              <Field
                label="Steps to reproduce"
                htmlFor="stepsToReproduce"
                required
                hint="Numbered, in order, starting from a known state."
              >
                <Textarea
                  id="stepsToReproduce"
                  name="stepsToReproduce"
                  rows={6}
                  required
                  minLength={5}
                  maxLength={10000}
                  placeholder={'1. Add an item to the cart\n2. Choose UPI at checkout\n3. Enter the PIN\n4. Return to the app'}
                />
              </Field>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--space-5)' }}>
                <Field label="Expected result" htmlFor="expectedResult">
                  <Textarea id="expectedResult" name="expectedResult" rows={3} maxLength={4000} />
                </Field>
                <Field label="Actual result" htmlFor="actualResult">
                  <Textarea id="actualResult" name="actualResult" rows={3} maxLength={4000} />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel title="How bad and how often">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-5)' }}>
              <Field label="Severity" htmlFor="severity" required>
                <Select
                  id="severity"
                  name="severity"
                  required
                  defaultValue="MEDIUM"
                  options={SEVERITIES.map((value) => ({ value, label: titleCase(value) }))}
                />
              </Field>
              <Field label="Reproducibility" htmlFor="reproducibility" required>
                <Select
                  id="reproducibility"
                  name="reproducibility"
                  required
                  defaultValue="ALWAYS"
                  options={REPRODUCIBILITIES.map((value) => ({ value, label: titleCase(value) }))}
                />
              </Field>
              {/*
                The evidence behind the summary above. "Sometimes" tells a
                triager very little; "3 out of 5" tells them how hard it will
                be to see for themselves. Both optional — but the API refuses
                one without the other, and refuses an occurrence larger than
                the attempts.
              */}
              <Field label="Times it happened" htmlFor="occurrence" hint="Optional. Leave both blank if you didn't count.">
                <Input id="occurrence" name="occurrence" type="number" min={0} max={10000} placeholder="3" />
              </Field>
              <Field label="Out of attempts" htmlFor="outOf" hint="Optional, but required if you filled the field to the left.">
                <Input id="outOf" name="outOf" type="number" min={1} max={10000} placeholder="5" />
              </Field>
              <Field label="Type" htmlFor="type" hint="Optional.">
                <Select
                  id="type"
                  name="type"
                  defaultValue=""
                  options={[
                    { value: '', label: 'Not sure' },
                    ...BUG_TYPES.map((value) => ({ value, label: titleCase(value) })),
                  ]}
                />
              </Field>
            </div>
          </Panel>

          <Panel
            title="Where you saw it"
            description="Optional, but a report without an environment is much harder to reproduce."
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-5)' }}>
              <Field label="Device" htmlFor="deviceModel">
                <Input id="deviceModel" name="deviceModel" maxLength={120} placeholder="Pixel 7a" />
              </Field>
              <Field label="OS" htmlFor="osName">
                <Input id="osName" name="osName" maxLength={60} placeholder="Android" />
              </Field>
              <Field label="OS version" htmlFor="osVersion">
                <Input id="osVersion" name="osVersion" maxLength={40} placeholder="14" />
              </Field>
              {/*
                A tester who registered their browsers under Assets picks one
                instead of retyping it — the string that reaches the API is
                the same either way, so nothing downstream has to know which
                path produced it. With no registered browsers this stays the
                plain input it always was rather than an empty dropdown.
              */}
              <Field
                label="Browser"
                htmlFor="browser"
                hint={browserOptions.length > 0 ? 'From the browsers on your profile.' : undefined}
              >
                {browserOptions.length > 0 ? (
                  <Select
                    id="browser"
                    name="browser"
                    defaultValue=""
                    options={[{ value: '', label: 'Not applicable' }, ...browserOptions]}
                  />
                ) : (
                  <Input id="browser" name="browser" maxLength={80} placeholder="Chrome 128" />
                )}
              </Field>
              <Field label="App version" htmlFor="appVersion">
                <Input id="appVersion" name="appVersion" maxLength={60} placeholder="4.3.1" />
              </Field>
              <Field label="Network" htmlFor="networkType">
                <Input id="networkType" name="networkType" maxLength={40} placeholder="5G" />
              </Field>
            </div>
          </Panel>

          {/* ── The client's own questions for this build (§72) ────────────
              Rendered between the standard form and Evidence, so the report
              reads in the order the client asked for it. Absent entirely when
              the build has no extra fields or has them switched off — the API
              returns nothing in either case. */}
          {customFields && customFields.length > 0 ? (
            <Panel
              title="Extra details for this build"
              description="Questions the client added to this build's bug form."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
                {customFields.map((field) => (
                  <CustomFieldInput key={field.id} field={field} />
                ))}
              </div>
            </Panel>
          ) : null}

          <Panel
            title="Evidence"
            description="Attach a screenshot or recording, or paste a link to one. This is what turns a description into something the team can act on, so at least one is required."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <Field
                label="Video link"
                htmlFor="videoUrl"
                hint="A publicly reachable recording — Loom, Drive, anything the team can open without an account."
              >
                <Input
                  id="videoUrl"
                  name="videoUrl"
                  type="url"
                  maxLength={2000}
                  placeholder="https://…"
                />
              </Field>
              <EvidenceUpload />
            </div>
          </Panel>

          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            <EvidenceGuardedSubmit pendingLabel="Filing report…">
              File the report
            </EvidenceGuardedSubmit>
            <Button variant="secondary" href="/app/tester/bugs">
              Cancel
            </Button>
          </div>
        </TrackedForm>
      )}
    </DetailShell>
  )
}

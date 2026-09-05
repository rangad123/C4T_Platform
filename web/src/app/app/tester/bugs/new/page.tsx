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
import { PairSelect } from '@/components/ds/forms/PairSelect'
import { loadBugEnvironmentOptions } from '@/lib/catalog/target-options'

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
 * Statuses in which the API accepts a report — mirrors `isProjectOpenForWork`
 * in `projects.service.ts`, so this page never offers a project that would be
 * rejected on submit.
 *
 * An allow-list, matching the API. As a deny-list this drifted: it refused
 * DRAFT, COMPLETED and CANCELLED but let PAUSED and SUBMITTED through, which
 * is exactly the hole the API side has now closed.
 */
const OPEN_TO_REPORTS: readonly string[] = ['APPROVED', 'IN_PROGRESS']

/** Assignment statuses that carry the right to file a bug (`bug.create`). */
const CAN_REPORT: readonly string[] = ['ACCEPTED', 'ACTIVE']

interface Assignment {
  status: string
  /** Which build THIS row is for — a tester can hold one row per build now. */
  build: { id: string; name: string }
  project: {
    id: string
    reference: string
    title: string
    status: string
  } | null
}

/** A row of `GET /v1/catalog/me/browsers` — what this tester actually runs. */
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
  const errorMessage = params.error ? (ERROR_MESSAGES[params.error] ?? ERROR_MESSAGES.failed) : null

  const assignments = await serverFetchOrNull<readonly Assignment[]>('projects/my-assignments')
  const reportable = (assignments ?? []).filter(
    (a) =>
      CAN_REPORT.includes(a.status) &&
      a.project !== null &&
      OPEN_TO_REPORTS.includes(a.project.status),
  )

  /**
   * The project is context, not a question.
   *
   * A bug is always filed from inside the build being tested — both "Report a
   * bug" entry points sit on the project page and carry `?projectId=&buildId=`
   * — so the form states what it is filing against rather than asking. The
   * picker this replaces was worse than redundant: `features` and
   * `customFields` below are fetched on the server for whatever project is
   * active at render, so changing the dropdown in the browser left the
   * Feature list and the client's custom questions belonging to the PREVIOUS
   * project, and the submit carried a `featureId` the chosen project does not
   * own.
   *
   * Only a project the tester can actually report against counts — a
   * hand-edited `?projectId=` for someone else's project resolves to nothing
   * and gets the "open a project" state below, rather than being quietly
   * swapped for a different project. There is deliberately no "first
   * reportable project" fallback: with no visible picker, defaulting would
   * file the report against a project nobody chose.
   *
   * The same principle now applies one level down: a tester can hold more
   * than one reportable assignment on the same project (one per build), so a
   * `?buildId=` — every real entry point sends one — must match too, not
   * just `projectId`. Missing a `buildId` (an older link) falls back to the
   * first reportable assignment on that project, same as before.
   */
  const preselected = params.buildId
    ? (reportable.find(
        (a) => a.project?.id === params.projectId && a.build.id === params.buildId,
      ) ?? null)
    : (reportable.find((a) => a.project?.id === params.projectId) ?? null)
  const activeProjectId = preselected?.project?.id ?? ''
  const activeBuildId = preselected?.build.id

  /**
   * Features and the tester's registered browsers make the report specific:
   * "sign up, on Chrome 128 / Windows 11" beats free-typed guesses. Both are
   * best-effort — a failure leaves the fields as plain inputs rather than
   * blocking the report, because an unfiled bug is worse than an unlabelled
   * one.
   */
  const [features, customFields] = await Promise.all([
    activeProjectId
      ? serverFetchOrNull<readonly { id: string; name: string }[]>(
          `projects/${activeProjectId}/features`,
          activeBuildId ? { query: { buildId: activeBuildId } } : undefined,
        )
      : Promise.resolve(null),
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
          activeBuildId ? { query: { buildId: activeBuildId } } : undefined,
        )
      : Promise.resolve(null),
  ])

  /* Device, OS, browser and network options — the tester's own kit first,
     then the catalog. One loader, so the report form and the edit form
     cannot offer different environments for the same bug. */
  const environment = await loadBugEnvironmentOptions()
  const deviceOptions = environment.devices
  const osGroups = environment.osGroups
  const browserOptions = environment.browsers
  const networkOptions = environment.networks
  return (
    <DetailShell
      root={{ label: 'Tester', href: '/app/tester' }}
      crumbs={[
        preselected?.project
          ? {
              label: preselected.project.title,
              href: `/app/tester/projects/${preselected.project.id}?section=bugs&buildId=${preselected.build.id}`,
            }
          : { label: 'Projects', href: '/app/tester/projects' },
        { label: 'Report a bug' },
      ]}
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

      {!preselected ? (
        reportable.length === 0 ? (
          <EmptyState
            icon="clipboard-check"
            title="No project to report against"
            description="You can file a bug once you have accepted an invitation to a project that is still running."
          />
        ) : (
          /*
           * Reachable only by opening this URL directly, since every link to
           * it carries a project. Rather than guess which of the tester's
           * projects they meant, send them to pick one — the bug form lives
           * inside a project, and that is where the button is.
           */
          <EmptyState
            icon="clipboard-check"
            title="Open a project to report a bug"
            description="Reports are filed against the build you are testing. Open the project, then use Report a bug."
            action={
              <Button href="/app/tester/projects" variant="primary">
                Go to your projects
              </Button>
            }
          />
        )
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
              {activeBuildId ? <input type="hidden" name="buildId" value={activeBuildId} /> : null}

              {/*
                The project travels as a hidden value, not a control. The
                action reads `projectId` exactly as before and the API still
                re-checks the assignment on submit — this removes the question,
                not the field.
              */}
              <input type="hidden" name="projectId" value={activeProjectId} />

              <div>
                <span
                  className="c4t-eyebrow"
                  style={{ display: 'block', color: 'var(--text-muted)' }}
                >
                  Project
                </span>
                <p
                  style={{
                    margin: 'var(--space-1) 0 0',
                    color: 'var(--text-primary)',
                    fontSize: 'var(--type-body-md-size)',
                  }}
                >
                  {preselected.project!.reference} — {preselected.project!.title} ·{' '}
                  {preselected.build.name}
                </p>
              </div>

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
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  required
                  minLength={10}
                  maxLength={10000}
                />
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
                  placeholder={
                    '1. Add an item to the cart\n2. Choose UPI at checkout\n3. Enter the PIN\n4. Return to the app'
                  }
                />
              </Field>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: 'var(--space-5)',
                }}
              >
                <Field label="Expected result" htmlFor="expectedResult" required>
                  <Textarea
                    id="expectedResult"
                    name="expectedResult"
                    rows={3}
                    required
                    minLength={5}
                    maxLength={4000}
                  />
                </Field>
                <Field label="Actual result" htmlFor="actualResult" required>
                  <Textarea
                    id="actualResult"
                    name="actualResult"
                    rows={3}
                    required
                    minLength={5}
                    maxLength={4000}
                  />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel title="How bad and how often">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
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
              <Field
                label="Times it happened"
                htmlFor="occurrence"
                hint="Optional. Leave both blank if you didn't count."
              >
                <Input
                  id="occurrence"
                  name="occurrence"
                  type="number"
                  min={0}
                  max={10000}
                  placeholder="3"
                />
              </Field>
              <Field
                label="Out of attempts"
                htmlFor="outOf"
                hint="Optional, but required if you filled the field to the left."
              >
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
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              {/*
                The environment a bug was seen in, from lists rather than five
                text boxes. A tester's own registered kit comes first — they are
                reporting from it — with the platform catalog behind it, so a
                device nobody has registered yet is still reportable.
              */}
              <Field label="Device" htmlFor="deviceModel">
                <Select
                  id="deviceModel"
                  name="deviceModel"
                  options={deviceOptions}
                  placeholder="Not specified"
                />
              </Field>
              <PairSelect
                groups={osGroups}
                parentName="osName"
                childName="osVersion"
                parentLabel="OS"
                childLabel="OS version"
                idPrefix="bug-os"
                emptyHint="The device catalog is unavailable right now."
              />
              <Field label="Browser" htmlFor="browser">
                <Select
                  id="browser"
                  name="browser"
                  options={browserOptions}
                  placeholder="Not applicable"
                />
              </Field>
              {/* App version stays text: it is the customer's own build
                  number, which no catalog can know. */}
              <Field label="App version" htmlFor="appVersion">
                <Input id="appVersion" name="appVersion" maxLength={60} placeholder="4.3.1" />
              </Field>
              <Field label="Network" htmlFor="networkType">
                <Select
                  id="networkType"
                  name="networkType"
                  options={networkOptions}
                  placeholder="Not specified"
                />
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
            <Button
              variant="secondary"
              href={
                preselected?.project
                  ? `/app/tester/projects/${preselected.project.id}?section=bugs&buildId=${preselected.build.id}`
                  : '/app/tester/projects'
              }
            >
              Cancel
            </Button>
          </div>
        </TrackedForm>
      )}
    </DetailShell>
  )
}

import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { EmptyState } from '@/components/ds/admin/EmptyState'
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

const ERROR_MESSAGES: Record<string, string> = {
  invalid: 'Some fields were missing or too short. Check the title, description and steps.',
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
export default async function NewTesterBugPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
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

  return (
    <main
      id="main"
      style={{
        maxWidth: 840,
        margin: '0 auto',
        padding: 'var(--space-9) var(--space-7)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <Link
          href="/app/tester/bugs"
          style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}
        >
          ← Back to bugs
        </Link>
        <h1 className="c4t-display-md" style={{ margin: 0 }}>
          Report a bug
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '70ch' }}>
          Write the steps so someone who has never seen the problem can reproduce it. That is
          the difference between a report that gets fixed and one that gets sent back.
        </p>
      </header>

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
              <Field label="Project" htmlFor="projectId" required>
                <Select
                  id="projectId"
                  name="projectId"
                  required
                  defaultValue={reportable[0]?.project?.id ?? ''}
                  options={reportable.map((a) => ({
                    value: a.project!.id,
                    label: `${a.project!.reference} — ${a.project!.title}`,
                  }))}
                />
              </Field>

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
              <Field label="Browser" htmlFor="browser">
                <Input id="browser" name="browser" maxLength={80} placeholder="Chrome 128" />
              </Field>
              <Field label="App version" htmlFor="appVersion">
                <Input id="appVersion" name="appVersion" maxLength={60} placeholder="4.3.1" />
              </Field>
              <Field label="Network" htmlFor="networkType">
                <Input id="networkType" name="networkType" maxLength={40} placeholder="5G" />
              </Field>
            </div>
          </Panel>

          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            <Button type="submit" variant="primary" iconLeft="clipboard-check">
              File the report
            </Button>
            <Button variant="secondary" href="/app/tester/bugs">
              Cancel
            </Button>
          </div>
        </TrackedForm>
      )}
    </main>
  )
}

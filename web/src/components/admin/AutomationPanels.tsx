import { Panel } from '@/components/admin/Panel'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { DownloadLink } from '@/components/admin/DownloadLink'
import { InlineFileUpload } from '@/components/admin/InlineFileUpload'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { formatDate } from '@/lib/admin/format'
import {
  addAutomationModule,
  addAutomationReport,
  deleteAutomationModule,
  deleteAutomationReport,
} from '@/lib/automation/actions'

export interface AutomationData {
  buildId: string
  canManage: boolean
  modules: {
    id: string
    name: string
    framework: string | null
    repositoryUrl: string | null
    owner: string | null
    createdAt: string
  }[]
  reports: {
    id: string
    runAt: string
    passed: number
    failed: number
    skipped: number
    durationSeconds: number | null
    notes: string | null
    module: { id: string; name: string } | null
    file: { id: string; originalName: string; isComplete: boolean } | null
  }[]
}

const NOTICES: Record<string, NoticeCopy> = {
  'module-added': { tone: 'success', message: 'The module is added.' },
  'module-removed': { tone: 'success', message: 'The module is removed.' },
  'report-added': { tone: 'success', message: 'The run is recorded.' },
  'report-removed': { tone: 'success', message: 'The run is removed.' },
}

const stack = { display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' } as const
const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 'var(--space-5)',
} as const
const muted = { margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }

function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/**
 * Automation modules and run reports for one build. One component for the
 * admin, customer and tester portals; the write forms show only when the API
 * says `canManage` and the portal passes an upload endpoint.
 */
export function AutomationPanels({
  data,
  projectId,
  returnTo,
  uploadEndpoint,
  downloadBase,
  notice,
  error,
}: {
  data: AutomationData
  projectId: string
  returnTo: string
  /** The portal's upload route; omit for a read-only portal. */
  uploadEndpoint?: string
  downloadBase: string
  notice?: string
  error?: string
}) {
  const manage = data.canManage && uploadEndpoint !== undefined
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="buildId" value={data.buildId} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  )

  type Module = AutomationData['modules'][number]
  type Report = AutomationData['reports'][number]

  const moduleColumns: TableColumn<Module>[] = [
    { key: 'name', header: 'Module', render: (m) => m.name, renderSecondary: (m) => m.owner },
    { key: 'framework', header: 'Framework', render: (m) => m.framework ?? '—' },
    {
      key: 'repository',
      header: 'Repository',
      render: (m) =>
        m.repositoryUrl ? (
          <a href={m.repositoryUrl} rel="noreferrer noopener" target="_blank">
            {m.repositoryUrl}
          </a>
        ) : (
          '—'
        ),
    },
    { key: 'added', header: 'Added', align: 'right', render: (m) => formatDate(m.createdAt) },
    ...(manage
      ? [
          {
            key: 'remove',
            header: '',
            render: (m: Module) => (
              <form action={deleteAutomationModule}>
                {hidden}
                <input type="hidden" name="moduleId" value={m.id} />
                <ConfirmSubmit iconLeft="x" question={`Remove ${m.name}?`}>
                  Remove
                </ConfirmSubmit>
              </form>
            ),
          },
        ]
      : []),
  ]

  const reportColumns: TableColumn<Report>[] = [
    {
      key: 'run',
      header: 'Run',
      render: (r) => formatDate(r.runAt),
      renderSecondary: (r) => r.module?.name ?? null,
    },
    { key: 'passed', header: 'Passed', align: 'right', render: (r) => r.passed },
    { key: 'failed', header: 'Failed', align: 'right', render: (r) => r.failed },
    { key: 'skipped', header: 'Skipped', align: 'right', render: (r) => r.skipped },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      render: (r) => duration(r.durationSeconds),
    },
    {
      key: 'report',
      header: 'Report',
      render: (r) =>
        r.file ? (
          <DownloadLink
            fileId={r.file.id}
            name={r.file.originalName}
            basePath={downloadBase}
            available={r.file.isComplete}
          />
        ) : (
          '—'
        ),
      renderSecondary: (r) => r.notes,
    },
    ...(manage
      ? [
          {
            key: 'remove',
            header: '',
            render: (r: Report) => (
              <form action={deleteAutomationReport}>
                {hidden}
                <input type="hidden" name="reportId" value={r.id} />
                <ConfirmSubmit iconLeft="x" question="Remove this run?">
                  Remove
                </ConfirmSubmit>
              </form>
            ),
          },
        ]
      : []),
  ]

  const notices: Record<string, NoticeCopy> = error
    ? { [error]: { tone: 'error', message: error } }
    : NOTICES

  return (
    <div style={stack}>
      <Notice code={error ?? notice} notices={notices} param={error ? 'error' : 'notice'} />

      <Panel title="Modules" description="The automated suites kept for this build.">
        <Table
          columns={moduleColumns}
          rows={data.modules}
          rowKey={(m) => m.id}
          ariaLabel="Automation modules"
          emptyState={<p style={muted}>No module is recorded for this build yet.</p>}
        />
      </Panel>

      <Panel title="Runs" description="What each automated run produced, newest first.">
        <Table
          columns={reportColumns}
          rows={data.reports}
          rowKey={(r) => r.id}
          ariaLabel="Automation runs"
          emptyState={<p style={muted}>No run is recorded for this build yet.</p>}
        />
      </Panel>

      {manage ? (
        <>
          <Panel title="Add a module" description="Name the suite, and where its code lives.">
            <form action={addAutomationModule} style={stack}>
              {hidden}
              <div style={grid}>
                <Field label="Name" htmlFor="automation-name" required>
                  <Input id="automation-name" name="name" required maxLength={200} />
                </Field>
                <Field label="Framework" htmlFor="automation-framework">
                  <Input
                    id="automation-framework"
                    name="framework"
                    maxLength={100}
                    placeholder="Playwright"
                  />
                </Field>
                <Field label="Repository" htmlFor="automation-repo" hint="A full https:// URL.">
                  <Input id="automation-repo" name="repositoryUrl" type="url" maxLength={2000} />
                </Field>
                <Field label="Owner" htmlFor="automation-owner" hint="Who looks after it.">
                  <Input id="automation-owner" name="owner" maxLength={200} />
                </Field>
              </div>
              <div>
                <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Adding…">
                  Add module
                </SubmitButton>
              </div>
            </form>
          </Panel>

          <Panel title="Record a run" description="The totals from one automated run.">
            <form action={addAutomationReport} style={stack}>
              {hidden}
              <div style={grid}>
                <Field label="Run date" htmlFor="automation-run-at" required>
                  <Input id="automation-run-at" name="runAt" type="date" required />
                </Field>
                <Field label="Module" htmlFor="automation-module">
                  <Select
                    id="automation-module"
                    name="moduleId"
                    placeholder="No module"
                    options={data.modules.map((m) => ({ value: m.id, label: m.name }))}
                  />
                </Field>
                <Field label="Passed" htmlFor="automation-passed" required>
                  <Input id="automation-passed" name="passed" type="number" min={0} required />
                </Field>
                <Field label="Failed" htmlFor="automation-failed" required>
                  <Input id="automation-failed" name="failed" type="number" min={0} required />
                </Field>
                <Field label="Skipped" htmlFor="automation-skipped" required>
                  <Input id="automation-skipped" name="skipped" type="number" min={0} required />
                </Field>
                <Field label="Duration in minutes" htmlFor="automation-duration">
                  <Input
                    id="automation-duration"
                    name="durationMinutes"
                    type="number"
                    min={0}
                    step="any"
                  />
                </Field>
                <Field
                  label="Report"
                  htmlFor="automation-file"
                  hint="Optional. PDF, Word, Excel, text or CSV."
                >
                  <InlineFileUpload
                    name="fileId"
                    endpoint={uploadEndpoint}
                    scope="test-document"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
                    label="Upload the report"
                  />
                </Field>
              </div>
              <Field label="Notes" htmlFor="automation-notes">
                <Textarea id="automation-notes" name="notes" rows={3} maxLength={5000} />
              </Field>
              <div>
                <SubmitButton variant="secondary" iconLeft="plus" pendingLabel="Recording…">
                  Record run
                </SubmitButton>
              </div>
            </form>
          </Panel>
        </>
      ) : null}
    </div>
  )
}

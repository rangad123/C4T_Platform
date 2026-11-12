import { Panel } from '@/components/admin/Panel'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Badge } from '@/components/ds/core/Badge'
import { Icon } from '@/components/ds/core/Icon'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { formatDateTime } from '@/lib/admin/format'
import {
  exportBugToJira,
  removeBugTrackerConnection,
  saveBugTrackerConnection,
  testBugTrackerConnection,
} from '@/lib/bug-tracker/actions'

/**
 * The Jira connection form and the per-bug Jira panel, shared by the
 * customer and admin pages. Server Components; the forms post to the
 * Server Actions in `lib/bug-tracker/actions.ts`.
 */

/** `GET /v1/bug-tracker/organisations/:id`. The token itself never comes back. */
export interface BugTrackerConnection {
  siteUrl: string
  accountEmail: string
  projectKey: string
  issueType: string
  tokenMasked: string
  lastTestedAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
}

/** `GET /v1/bug-tracker/bugs/:id`. */
export interface BugExport {
  connected: boolean
  canExport: boolean
  issue: {
    key: string | null
    url: string | null
    status: 'PENDING' | 'EXPORTED' | 'FAILED'
    lastError: string | null
  } | null
}

export const BUG_TRACKER_NOTICES: Record<string, NoticeCopy> = {
  'jira-saved': { tone: 'success', message: 'Jira connection saved. Test it before exporting.' },
  'jira-tested': { tone: 'info', message: 'Connection tested. The result is below.' },
  'jira-removed': { tone: 'success', message: 'Jira connection removed.' },
  'jira-exported': { tone: 'success', message: 'Exported to Jira.' },
}

/** The API's own refusal, carried back on `?error=`. */
export function ActionError({ message }: { message: string | undefined }) {
  if (!message) return null
  return (
    <p
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        margin: 0,
        padding: 'var(--space-4) var(--space-5)',
        background: 'var(--status-error-bg)',
        color: 'var(--status-error-fg)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        fontSize: 'var(--type-body-sm-size)',
      }}
    >
      <Icon name="alert-triangle" size={16} />
      <span>{message.slice(0, 240)}</span>
    </p>
  )
}

export function BugTrackerNotices({ notice, error }: { notice?: string; error?: string }) {
  return (
    <>
      <Notice code={notice} notices={BUG_TRACKER_NOTICES} />
      <ActionError message={error} />
    </>
  )
}

const row = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-4)',
  alignItems: 'flex-end',
} as const
const muted = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 'var(--type-body-sm-size)',
} as const

export function BugTrackerConnectionPanel({
  orgId,
  back,
  connection,
}: {
  orgId: string
  /** The page to come back to after each action. */
  back: string
  connection: BugTrackerConnection | null
}) {
  return (
    <Panel
      title="Jira"
      description="Connect your Jira Cloud site to send bugs to it. The API token is stored encrypted and is never shown again."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {connection ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-4)',
              alignItems: 'center',
            }}
          >
            {connection.lastTestOk === true ? (
              <Badge tone="success" icon="check" uppercase={false}>
                Working
              </Badge>
            ) : connection.lastTestOk === false ? (
              <Badge tone="error" icon="alert-triangle" uppercase={false}>
                Not working
              </Badge>
            ) : (
              <Badge tone="neutral" uppercase={false}>
                Not tested
              </Badge>
            )}
            <span style={muted}>
              {connection.lastTestedAt
                ? `Tested ${formatDateTime(connection.lastTestedAt)}`
                : 'Not tested yet'}
              {connection.lastTestError ? ` · ${connection.lastTestError}` : ''}
            </span>
          </div>
        ) : (
          <p style={muted}>No Jira site is connected yet.</p>
        )}

        <form
          action={saveBugTrackerConnection}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="back" value={back} />
          <div style={row}>
            <Field
              label="Site address"
              htmlFor="jira-site"
              required
              hint="https://your-team.atlassian.net"
            >
              <Input
                id="jira-site"
                name="siteUrl"
                type="url"
                required
                maxLength={200}
                defaultValue={connection?.siteUrl ?? ''}
                autoComplete="off"
              />
            </Field>
            <Field label="Account email" htmlFor="jira-email" required>
              <Input
                id="jira-email"
                name="accountEmail"
                type="email"
                required
                maxLength={254}
                defaultValue={connection?.accountEmail ?? ''}
                autoComplete="off"
              />
            </Field>
            <Field
              label="API token"
              htmlFor="jira-token"
              required={!connection}
              hint={
                connection
                  ? `Saved: ${connection.tokenMasked}. Leave blank to keep it.`
                  : 'Create one in your Atlassian account settings.'
              }
            >
              <Input
                id="jira-token"
                name="apiToken"
                type="password"
                required={!connection}
                maxLength={500}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div style={row}>
            <Field label="Project key" htmlFor="jira-project" required hint="For example QA">
              <Input
                id="jira-project"
                name="projectKey"
                required
                maxLength={20}
                defaultValue={connection?.projectKey ?? ''}
                autoComplete="off"
              />
            </Field>
            <Field label="Issue type" htmlFor="jira-type" hint="Usually Bug">
              <Input
                id="jira-type"
                name="issueType"
                maxLength={60}
                defaultValue={connection?.issueType ?? 'Bug'}
                autoComplete="off"
              />
            </Field>
          </div>
          <div>
            <SubmitButton iconLeft="plug" pendingLabel="Saving…">
              {connection ? 'Save changes' : 'Connect Jira'}
            </SubmitButton>
          </div>
        </form>

        {connection ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
            <form action={testBugTrackerConnection}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="back" value={back} />
              <SubmitButton variant="secondary" iconLeft="refresh-cw" pendingLabel="Testing…">
                Test connection
              </SubmitButton>
            </form>
            <form action={removeBugTrackerConnection}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="back" value={back} />
              <ConfirmSubmit
                question="Remove the Jira connection? Bugs already exported keep their links."
                confirmLabel="Yes, remove"
                iconLeft="trash-2"
              >
                Remove connection
              </ConfirmSubmit>
            </form>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

/** On a bug page: the Jira link once exported, else the export button. */
export function JiraIssuePanel({
  bugId,
  back,
  state,
  connectHref,
  error,
}: {
  bugId: string
  back: string
  state: BugExport | null
  /** Where the connection is managed, when this viewer can manage it. */
  connectHref?: string
  /** `?jiraError=` from a refused export. */
  error?: string
}) {
  if (!state) return null
  const issue = state.issue
  if (!issue && !state.canExport) return null

  return (
    <Panel title="Jira">
      {error ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <ActionError message={error} />
        </div>
      ) : null}
      {issue?.status === 'EXPORTED' && issue.url ? (
        <p style={{ margin: 0, display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <Icon name="link-2" size={16} />
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--text-link)' }}
          >
            {issue.key}
          </a>
        </p>
      ) : !state.canExport ? null : !state.connected ? (
        <p style={muted}>
          No Jira site is connected for this organisation.
          {connectHref ? (
            <>
              {' '}
              <a href={connectHref} style={{ color: 'var(--text-link)' }}>
                Connect Jira
              </a>
            </>
          ) : null}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {issue?.status === 'FAILED' && issue.lastError ? (
            <p style={muted}>Last attempt failed: {issue.lastError}</p>
          ) : null}
          <form action={exportBugToJira}>
            <input type="hidden" name="bugId" value={bugId} />
            <input type="hidden" name="back" value={back} />
            <SubmitButton variant="secondary" iconLeft="upload" pendingLabel="Exporting…">
              {issue?.status === 'FAILED' ? 'Try the export again' : 'Export to Jira'}
            </SubmitButton>
          </form>
        </div>
      )}
    </Panel>
  )
}

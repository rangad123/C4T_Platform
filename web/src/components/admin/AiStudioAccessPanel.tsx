import { Panel } from '@/components/admin/Panel'
import { Modal } from '@/components/admin/Modal'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { serverFetch } from '@/lib/api/server'
import type { SessionUser } from '@/lib/api/types'
import { hasPermission } from '@/lib/auth/session'
import {
  compareAiStudioCodes,
  isAiStudioAccountKind,
  isAiStudioCode,
  presetsFor,
  type AiStudioAccountKind,
} from '@/lib/admin/ai-studio-access'
import { setAiStudioAccess } from '@/lib/admin/ai-studio-access-actions'

/**
 * "AI Studio access" — which AI Studio features one person may use.
 *
 * Shared by the user, tester and manager pages, so a tester's access reads the
 * same wherever an admin finds them. It follows the sub-admin permissions
 * editor on the user page: a read-only summary, an Edit button, and a
 * URL-driven modal holding a plain checkbox form.
 *
 * Only the codes the API accepts for this kind of account are offered
 * (`?grantableTo=`), so a tester is never shown "View AI usage and cost". The
 * API refuses them anyway if they are sent.
 *
 * Presets are links that reopen the modal with their boxes ticked: no client
 * state, and nothing is saved until the admin presses Save. Which projects a
 * person reaches is set in AI Studio, per project, not here.
 *
 * Rendered only for admins and sub-admins holding `subadmin.manage`, the same
 * permission the API demands for reading and writing grants.
 */

interface PermissionEntry {
  code: string
  group: string
  label: string
  description?: string | null
}

interface GrantEntry {
  code: string
  label: string
}

export interface AiStudioAccessPanelProps {
  viewer: SessionUser
  user: { id: string; role: string }
  /**
   * This page as it should be after the modal closes: its path plus any
   * query it keeps (`?section=profile`), without `edit` or notices.
   */
  pagePath: string
  edit?: string
  preset?: string
  notice?: string
  reason?: string
}

const NOUNS: Record<AiStudioAccountKind, string> = {
  CUSTOMER: 'customer',
  TESTER: 'tester',
  SUB_ADMIN: 'manager',
}

const noteStyle = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: 'var(--type-body-sm-size)',
  lineHeight: 1.55,
}

const stackStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-5)',
}

function withQuery(path: string, query: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${query}`
}

export async function AiStudioAccessPanel({
  viewer,
  user,
  pagePath,
  edit,
  preset,
  notice,
  reason,
}: AiStudioAccessPanelProps) {
  if (!hasPermission(viewer, 'subadmin.manage')) return null
  if (!isAiStudioAccountKind(user.role)) return null
  const kind = user.role
  const noun = NOUNS[kind]

  let offered: PermissionEntry[] = []
  let granted: GrantEntry[] = []
  let loadFailed = false
  try {
    const [catalogue, grants] = await Promise.all([
      serverFetch<PermissionEntry[]>('users/permissions/catalogue', {
        query: { grantableTo: kind },
      }),
      serverFetch<GrantEntry[]>(`users/${user.id}/permissions`),
    ])
    offered = catalogue
      .filter((entry) => isAiStudioCode(entry.code))
      .sort((a, b) => compareAiStudioCodes(a.code, b.code))
    granted = grants
      .filter((grant) => isAiStudioCode(grant.code))
      .sort((a, b) => compareAiStudioCodes(a.code, b.code))
  } catch {
    loadFailed = true
  }

  const isSelf = viewer.id === user.id
  const editable = !loadFailed && !isSelf && offered.length > 0
  const editHref = withQuery(pagePath, 'edit=ai-studio')
  const presets = presetsFor(kind)
  const chosenPreset = presets.find((candidate) => candidate.value === preset)
  const offeredCodes = new Set(offered.map((entry) => entry.code))
  const ticked = new Set(
    chosenPreset
      ? chosenPreset.codes.filter((code) => offeredCodes.has(code))
      : granted.map((grant) => grant.code),
  )

  const notices: Record<string, NoticeCopy> = {
    saved: { tone: 'success', message: 'AI Studio access updated.' },
    refused: {
      tone: 'error',
      message: reason?.trim()
        ? reason
        : 'That AI Studio access could not be given to this account.',
    },
    failed: { tone: 'error', message: 'AI Studio access did not save. Try again in a moment.' },
  }

  return (
    <>
      <Panel
        title="AI Studio access"
        description={`The AI Studio features this ${noun} may use. Projects are given in AI Studio, one at a time.`}
        actions={
          editable ? (
            <Button href={editHref} variant="primary" size="sm" iconLeft="pencil">
              Edit
            </Button>
          ) : undefined
        }
      >
        <div style={stackStyle}>
          <Notice code={notice} notices={notices} param="aiStudioNotice" />
          {loadFailed ? (
            <p style={noteStyle}>
              AI Studio access could not be loaded. The users service may be unreachable. Refresh in
              a moment.
            </p>
          ) : granted.length === 0 ? (
            <p style={noteStyle}>
              No AI Studio access. The AI Studio entry is hidden from their portal.
            </p>
          ) : (
            <ul
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-3)',
                listStyle: 'none',
                margin: 0,
                padding: 0,
              }}
            >
              {granted.map((grant) => (
                <li key={grant.code}>
                  <Badge tone="neutral" uppercase={false}>
                    {grant.label}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {isSelf ? (
            <p style={noteStyle}>
              This is your own account, and nobody can change their own permissions. Ask another
              administrator.
            </p>
          ) : null}
        </div>
      </Panel>

      {editable ? (
        <Modal open={edit === 'ai-studio'} closedHref={pagePath} title="Edit AI Studio access">
          {/* Keyed by preset: the checkboxes are uncontrolled, so a new
              preset must remount them for its ticks to show. */}
          <TrackedForm key={chosenPreset?.value ?? 'current'} action={setAiStudioAccess}>
            <div style={{ ...stackStyle, gap: 'var(--space-6)' }}>
              <input type="hidden" name="id" value={user.id} />
              <input type="hidden" name="returnTo" value={pagePath} />

              {presets.length > 0 ? (
                <div style={{ ...stackStyle, gap: 'var(--space-3)' }}>
                  <p className="c4t-eyebrow" style={{ margin: 0, color: 'var(--text-muted)' }}>
                    Start from a preset
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
                    {presets.map((candidate) => (
                      <Button
                        key={candidate.value}
                        href={withQuery(editHref, `aiPreset=${candidate.value}`)}
                        variant={candidate.value === chosenPreset?.value ? 'primary' : 'secondary'}
                        size="sm"
                      >
                        {candidate.label}
                      </Button>
                    ))}
                  </div>
                  <p style={noteStyle}>
                    A preset only ticks boxes. Nothing changes until you save, and you can adjust
                    any box first.
                  </p>
                </div>
              ) : null}

              <fieldset
                style={{
                  margin: 0,
                  padding: 0,
                  border: 0,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: 'var(--space-4) var(--space-6)',
                  maxHeight: '50vh',
                  overflowY: 'auto',
                }}
              >
                <legend className="c4t-eyebrow" style={{ padding: 0, color: 'var(--text-muted)' }}>
                  Features
                </legend>
                {offered.map((permission) => (
                  <Checkbox
                    key={permission.code}
                    id={`ai-studio-${permission.code}`}
                    name="permissionCodes"
                    value={permission.code}
                    defaultChecked={ticked.has(permission.code)}
                    label={permission.label}
                    description={permission.description ?? undefined}
                  />
                ))}
              </fieldset>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-5)',
                  flexWrap: 'wrap',
                  paddingTop: 'var(--space-6)',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <SubmitButton variant="primary" pendingLabel="Saving…">
                  Save changes
                </SubmitButton>
                <Button href={pagePath} variant="ghost">
                  Cancel
                </Button>
                <span style={noteStyle}>
                  Without Open AI Studio, the other features have no effect. Every unticked box is
                  withdrawn.
                </span>
              </div>
            </div>
          </TrackedForm>
        </Modal>
      ) : null}
    </>
  )
}

import type { PublicHrEmployee } from '@/lib/hrms/hr-types'
import { changeHrPassword } from '@/lib/hrms/hr-profile-actions'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { Avatar } from '@/components/admin/Avatar'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Enter your current password and a new one.',
  mismatch: "The new password and its confirmation don't match.",
  incorrect: 'Your current password is incorrect.',
  rejected: 'That password was rejected. It must be at least 12 characters.',
}

/**
 * Shared by both portals' `/profile` page. `returnPath` closes the loop the
 * change-password Server Action needs: it redirects back to whichever
 * portal's own profile page the form was submitted from.
 */
export function HrProfileContent({
  employee,
  returnPath,
  notice,
  error,
}: {
  employee: PublicHrEmployee
  returnPath: string
  notice?: string
  error?: string
}) {
  const displayName = `${employee.firstName} ${employee.lastName}`.trim() || employee.email
  const message = error ? (ERROR_MESSAGES[error] ?? 'Could not change your password.') : null

  return (
    <>
      <Panel title="Your details">
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-5)',
            alignItems: 'center',
            marginBottom: 'var(--space-6)',
          }}
        >
          <Avatar name={displayName} fileId={employee.profilePictureFileId} size="lg" />
        </div>
        <DescriptionList
          items={[
            { label: 'Name', value: displayName },
            { label: 'Employee code', value: employee.employeeCode },
            { label: 'Email', value: employee.email },
            { label: 'Role', value: <StatusBadge status={employee.role} /> },
          ]}
        />
      </Panel>

      <Panel title="Change password">
        {notice === 'password_changed' ? (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              padding: 'var(--space-4) var(--space-5)',
              marginBottom: 'var(--space-5)',
              background: 'var(--status-success-bg)',
              color: 'var(--status-success-fg)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            <Icon name="check-circle-2" size={18} style={{ flex: 'none' }} />
            <span>Your password has been updated.</span>
          </div>
        ) : null}

        {message ? (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              padding: 'var(--space-4) var(--space-5)',
              marginBottom: 'var(--space-5)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            <Icon name="alert-triangle" size={18} style={{ flex: 'none' }} />
            <span>{message}</span>
          </div>
        ) : null}

        <TrackedForm
          action={changeHrPassword}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', maxWidth: 420 }}
        >
          <input type="hidden" name="returnTo" value={returnPath} />
          <Field label="Current password" htmlFor="currentPassword" required>
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              required
              showPasswordToggle
            />
          </Field>
          <Field label="New password" htmlFor="newPassword" required hint="At least 12 characters.">
            <Input
              id="newPassword"
              name="newPassword"
              type="password"
              required
              minLength={12}
              showPasswordToggle
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirmPassword" required>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              required
              minLength={12}
              showPasswordToggle
            />
          </Field>
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Change password
          </SubmitButton>
        </TrackedForm>
      </Panel>
    </>
  )
}

import { Panel } from '@/components/admin/Panel'
import { Badge } from '@/components/ds/core/Badge'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { serverFetchOrNull } from '@/lib/api/server'
import { setEmailNotificationsAction } from '@/lib/settings/email-notifications'

/**
 * "Email notifications: on / off", for whichever settings page mounts it.
 *
 * One component for all three portals. The preference is a property of the
 * person, not of the role they signed in as, and it is the same flag the
 * unsubscribe link in every email footer clears — so there is exactly one
 * place that renders it and one action that writes it.
 *
 * No client JavaScript: a toggle that has to survive a failed request is a
 * form, and a form that posts the value it wants is simpler than a switch
 * that has to be told how to roll itself back.
 */
export async function EmailNotificationsPanel({ returnTo }: { returnTo: string }) {
  /**
   * `OrNull`, and a default of "on" if the read fails. The panel is one item
   * on a settings page — a blip reaching the API here must not take the
   * password form down with it, and "on" is what the column defaults to, so a
   * reader is never shown "off" for an account that is in fact still being
   * emailed.
   */
  const preference = await serverFetchOrNull<{ emailNotifications: boolean }>(
    'notifications/preferences',
  )
  const enabled = preference?.emailNotifications ?? true

  return (
    <Panel
      title="Email notifications"
      description="Whether we email you when something needs your attention — a project invitation, a message, an announcement."
      actions={<Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <p
          style={{
            margin: 0,
            color: 'var(--text-secondary)',
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 1.6,
          }}
        >
          {enabled
            ? 'Everything also appears in the app under the bell, so turning this off means you will only see it when you sign in.'
            : 'Notifications still appear in the app under the bell. Payments and changes to your account are emailed either way.'}
        </p>

        <form action={setEmailNotificationsAction}>
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
          <SubmitButton
            variant={enabled ? 'secondary' : 'primary'}
            size="sm"
            pendingLabel="Saving…"
          >
            {enabled ? 'Turn off email notifications' : 'Turn on email notifications'}
          </SubmitButton>
        </form>
      </div>
    </Panel>
  )
}

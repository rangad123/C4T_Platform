import { Panel } from '@/components/admin/Panel'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { serverFetchOrNull } from '@/lib/api/server'
import { setNotificationTypesAction } from '@/lib/settings/notification-types'

interface TypePreference {
  type: string
  essential: boolean
  inApp: boolean
  email: boolean
}

const LABELS: Record<string, string> = {
  PROJECT_ASSIGNED: 'Project invitations',
  PROJECT_STATUS_CHANGED: 'Project status changes',
  BUG_REPORTED: 'New bugs',
  BUG_STATUS_CHANGED: 'Bug status changes',
  MESSAGE_RECEIVED: 'Messages',
  RATING_RECEIVED: 'Ratings',
  TRANSACTION_UPDATED: 'Payments',
  TESTER_STATUS_CHANGED: 'Account status',
  ANNOUNCEMENT: 'Announcements',
  SYSTEM: 'Other platform notices',
}

/**
 * Which kinds of notification you receive, in the app and by email. One
 * component for all three portals, beside `EmailNotificationsPanel` (the
 * master email switch). Payments and account status are always on.
 *
 * A form of uncontrolled checkboxes, no client JavaScript. If the read fails
 * the panel is left out rather than showing every box ticked.
 */
export async function NotificationTypesPanel({ returnTo }: { returnTo: string }) {
  const preferences = await serverFetchOrNull<{ types?: TypePreference[] }>(
    'notifications/preferences',
  )
  const types = preferences?.types
  if (!types || types.length === 0) return null

  const cell = { display: 'flex', alignItems: 'center', gap: 'var(--space-5)' } as const

  return (
    <Panel
      title="What you are notified about"
      description="Choose, for each kind of notification, whether it appears under the bell and whether we email it."
    >
      <form
        action={setNotificationTypesAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <input type="hidden" name="returnTo" value={returnTo} />
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {types.map((pref) => {
            const label = LABELS[pref.type] ?? pref.type
            return (
              <li
                key={pref.type}
                style={{
                  ...cell,
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  padding: 'var(--space-3) 0',
                  borderBottom: '1px solid var(--border-default)',
                }}
              >
                <span style={{ fontSize: 'var(--type-body-sm-size)' }}>
                  {label}
                  {pref.essential ? (
                    <span style={{ color: 'var(--text-muted)' }}> · always on</span>
                  ) : null}
                </span>
                {pref.essential ? null : (
                  <span style={cell}>
                    <input type="hidden" name="type" value={pref.type} />
                    <Checkbox
                      name={`inApp:${pref.type}`}
                      label="In the app"
                      aria-label={`${label}: in the app`}
                      defaultChecked={pref.inApp}
                    />
                    <Checkbox
                      name={`email:${pref.type}`}
                      label="By email"
                      aria-label={`${label}: by email`}
                      defaultChecked={pref.email}
                    />
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        <div>
          <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
            Save notification choices
          </SubmitButton>
        </div>
      </form>
    </Panel>
  )
}

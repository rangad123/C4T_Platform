import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { requirePermission } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { createAnnouncement } from '../actions'

const LIST_PATH = '/app/admin/communication'

/**
 * The four `AnnouncementAudience` values, with what each one actually means for
 * delivery. The API decides who may READ an announcement by mapping the caller's
 * role to a permitted audience set (`announcementAudienceFor`), so these
 * descriptions are the reach, not a hint.
 */
const AUDIENCES: readonly { value: string; label: string; description: string }[] = [
  {
    value: 'ALL',
    label: 'Everyone',
    description: 'Customers, testers and the admin side all see it.',
  },
  {
    value: 'CUSTOMERS',
    label: 'Customers',
    description: 'Customer accounts only. Testers never see it.',
  },
  {
    value: 'TESTERS',
    label: 'Testers',
    description: 'Testers only. Customers never see it.',
  },
  {
    value: 'ADMINS',
    label: 'Admin side',
    description: 'Admins and sub-admins only — an internal note.',
  },
]

const TIMING: readonly { value: string; label: string; description: string }[] = [
  {
    value: 'now',
    label: 'Publish now',
    description: 'Live the moment you save. The audience you picked sees it immediately.',
  },
  {
    value: 'draft',
    label: 'Save as a draft',
    description:
      'Stored and shown to nobody. The API has no publish step, so a draft has to be composed again to send it.',
  },
]

/**
 * Radio geometry, matched to the DS Checkbox's 20px box so a radio and a
 * checkbox line up in the same form. There is no Radio component in
 * `components/ds/forms`, and adding one is outside this page's remit, so the
 * native control is used with its own appearance intact — which also keeps the
 * platform focus ring rather than replacing it.
 */
const RADIO_SIZE = 20

/**
 * `/app/admin/communication/announcements/new` — compose an announcement.
 *
 * The audience choice gets its own panel of full-width radio cards rather than a
 * dropdown. It is the one field on this form that cannot be corrected: there is
 * no update route on the API, so an announcement sent to every tester can only
 * be deleted, and anyone who already read it has read it. A collapsed select
 * that quietly defaults to "Everyone" is the wrong control for that.
 *
 * Publishing is likewise a radio, not a second submit button: the DS Button
 * takes no `name`/`value`, so two submits could not be told apart in the action,
 * and a checkbox labelled "publish" would leave the button's own label lying
 * about what it does half the time.
 */
export default async function NewAnnouncementPage() {
  await requirePermission('announcement.write')

  // The project picker is a list, not a search — the platform has few enough
  // projects that a Select with all of them is fine, and avoids pulling in an
  // async typeahead just for this one field. Sorted by reference so the most
  // recent cycle is at the top — same ordering as the projects list.
  const projects = await serverFetchOrNull<readonly { id: string; reference: string; title: string }[]>(
    'projects?limit=200',
  )

  return (
    <DetailShell
      crumbs={[
        { label: 'Communication', href: LIST_PATH },
        { label: 'New announcement' },
      ]}
      eyebrow="Operations"
      title="Compose an announcement"
      subtitle="One author, many readers. Pick the audience carefully — the API has no edit route, so a published announcement can only be deleted."
      aside={
        <Panel title="Before you save">
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            {[
              'The audience is final. There is no way to narrow or widen it afterwards.',
              'Publishing is instant. Nothing can be scheduled for later.',
              'Nothing here can be edited once saved — only deleted.',
              'An expiry is optional, and stops the announcement showing after that time.',
            ].map((note) => (
              <li
                key={note}
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  alignItems: 'flex-start',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--type-body-sm-size)',
                  lineHeight: 1.5,
                }}
              >
                <span style={{ color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>
                  <Icon name="info" size={16} />
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </Panel>
      }
    >
      <form
        action={createAnnouncement}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
      >
        <Panel title="What it says">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <Field
              label="Title"
              htmlFor="title"
              required
              hint="Between 3 and 200 characters. This is the line readers scan."
            >
              <Input
                id="title"
                name="title"
                type="text"
                required
                minLength={3}
                maxLength={200}
                placeholder="Scheduled maintenance on Sunday"
              />
            </Field>

            <Field
              label="Body"
              htmlFor="body"
              required
              hint="Up to 10,000 characters. Plain text — line breaks are kept."
            >
              <Textarea
                id="body"
                name="body"
                rows={10}
                required
                maxLength={10000}
                placeholder="Say what is changing, when it happens, and what the reader needs to do."
              />
            </Field>
          </div>
        </Panel>

        <Panel
          title="Who receives this"
          description="This decides who the announcement reaches. It cannot be changed later."
        >
          <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend className="c4t-visually-hidden">Audience</legend>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              {AUDIENCES.map((option) => (
                <label
                  key={option.value}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-4)',
                    alignItems: 'flex-start',
                    padding: 'var(--space-5)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--surface-canvas)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="audience"
                    value={option.value}
                    defaultChecked={option.value === 'ALL'}
                    required
                    style={{
                      flex: 'none',
                      width: RADIO_SIZE,
                      height: RADIO_SIZE,
                      marginTop: 'var(--space-1)',
                      accentColor: 'var(--accent-base)',
                      cursor: 'inherit',
                    }}
                  />
                  <span>
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--text-primary)',
                        fontSize: 'var(--type-body-md-size)',
                        fontWeight: 'var(--fw-semibold)',
                      }}
                    >
                      {option.label}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        marginTop: 'var(--space-1)',
                        color: 'var(--text-secondary)',
                        fontSize: 'var(--type-body-sm-size)',
                        lineHeight: 1.5,
                      }}
                    >
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </Panel>

        <Panel
          title="Limit to one project"
          description="Optional. Leave on Platform-wide when the announcement is for everyone."
        >
          {projects && projects.length > 0 ? (
            <Field
              label="Scope"
              htmlFor="projectId"
              hint="Pick a project to show the announcement only to its testers and customer members. Pick Platform-wide (the first option) for the usual reach."
            >
              <Select
                id="projectId"
                name="projectId"
                defaultValue=""
                options={[
                  { value: '', label: 'Platform-wide' },
                  ...projects.map((p) => ({
                    value: p.id,
                    label: `${p.reference} — ${p.title}`,
                  })),
                ]}
              />
            </Field>
          ) : (
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
              No projects are available to scope to. The announcement will be platform-wide.
            </p>
          )}
        </Panel>

        <Panel
          title="When it goes out"
          description="Saving either publishes it straight away or files it as a hidden draft."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend className="c4t-visually-hidden">Publishing</legend>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: 'var(--space-4)',
                }}
              >
                {TIMING.map((option) => (
                  <label
                    key={option.value}
                    style={{
                      display: 'flex',
                      gap: 'var(--space-4)',
                      alignItems: 'flex-start',
                      padding: 'var(--space-5)',
                      border: '1px solid var(--border-default)',
                      borderRadius: 'var(--radius-card)',
                      background: 'var(--surface-canvas)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="timing"
                      value={option.value}
                      defaultChecked={option.value === 'now'}
                      required
                      style={{
                        flex: 'none',
                        width: RADIO_SIZE,
                        height: RADIO_SIZE,
                        marginTop: 'var(--space-1)',
                        accentColor: 'var(--accent-base)',
                        cursor: 'inherit',
                      }}
                    />
                    <span>
                      <span
                        style={{
                          display: 'block',
                          color: 'var(--text-primary)',
                          fontSize: 'var(--type-body-md-size)',
                          fontWeight: 'var(--fw-semibold)',
                        }}
                      >
                        {option.label}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          marginTop: 'var(--space-1)',
                          color: 'var(--text-secondary)',
                          fontSize: 'var(--type-body-sm-size)',
                          lineHeight: 1.5,
                        }}
                      >
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <Field
              label="Stop showing it after"
              htmlFor="expiresAt"
              hint="Optional. Leave it empty to keep the announcement up indefinitely."
            >
              <Input id="expiresAt" name="expiresAt" type="datetime-local" />
            </Field>
          </div>
        </Panel>

        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary" iconLeft="radio-tower">
            Save announcement
          </Button>
          <Button variant="secondary" href={LIST_PATH}>
            Back to announcements
          </Button>
        </div>
      </form>
    </DetailShell>
  )
}

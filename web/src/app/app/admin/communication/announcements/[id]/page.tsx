import { notFound } from 'next/navigation'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Modal } from '@/components/admin/Modal'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Textarea } from '@/components/ds/forms/Textarea'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'
import { formatDateTime, personName, titleCase } from '@/lib/admin/format'
import { updateAnnouncement, publishAnnouncement, deleteAnnouncement } from '../actions'

interface AnnouncementDetail {
  id: string
  title: string
  body: string
  audience: string
  publishedAt: string | null
  expiresAt: string | null
  author: { id: string; firstName: string | null; lastName: string | null }
}

const LIST_PATH = '/app/admin/communication/announcements'

const ERROR_MESSAGES: Record<string, string> = {
  denied: 'Your session is no longer valid. Sign in again, then try that once more.',
  missing: 'That announcement no longer exists — someone may have deleted it.',
  invalid: 'Some values were not accepted. Check the title, body and expiry.',
  failed: 'That could not be saved. Try again.',
}

/**
 * `/app/admin/communication/announcements/[id]` — one announcement, and what
 * can still be done to it.
 *
 * ── WHAT THIS PAGE COULD NOT DO
 *
 * It was read-only, and so was the whole feature. An announcement could be
 * created and then nothing else: a draft could never be published (the API
 * set `publishedAt` only at create time and had no route to change it), a
 * typo could never be fixed, and although the API has always had a DELETE
 * route no page ever called it — so the composer's warning that an
 * announcement "can only be deleted" described something the panel could not
 * do either. "Save as draft" wrote a row that was invisible forever.
 *
 * ── WHY PUBLISH IS ITS OWN BUTTON
 *
 * Publishing is not a save. It makes the announcement visible and notifies
 * every reader in its audience, and neither can be taken back — so it is a
 * deliberate, confirmed act rather than a side effect of pressing Save.
 *
 * The audience is fixed once chosen and the API refuses the field, so it is
 * shown here and not offered for edit. See the PATCH handler for why.
 */
export default async function AnnouncementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ edit?: string; error?: string; published?: string }>
}) {
  const { id } = await params
  const query = await searchParams

  await requirePermission('announcement.write')

  let announcement: AnnouncementDetail
  try {
    announcement = await serverFetch<AnnouncementDetail>(`communication/announcements/${id}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const detailPath = `${LIST_PATH}/${id}`
  const isDraft = announcement.publishedAt === null
  const expired = announcement.expiresAt !== null && new Date(announcement.expiresAt) < new Date()
  const status = isDraft ? 'Draft' : expired ? 'Expired' : 'Published'
  const errorMessage = query.error ? (ERROR_MESSAGES[query.error] ?? ERROR_MESSAGES.failed) : null

  return (
    <DetailShell
      crumbs={[
        { label: 'Communication', href: '/app/admin/communication' },
        { label: 'Announcements', href: LIST_PATH },
        { label: announcement.title },
      ]}
      eyebrow="Operations"
      title={announcement.title}
      badges={
        <span style={{ display: 'inline-flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Badge tone={audienceTone(announcement.audience)} uppercase={false}>
            {titleCase(announcement.audience)}
          </Badge>
          <Badge tone={isDraft ? 'neutral' : expired ? 'warning' : 'success'} uppercase={false}>
            {status}
          </Badge>
        </span>
      }
      aside={
        <Panel
          title={isDraft ? 'This draft' : 'This announcement'}
          description={
            isDraft
              ? 'Nobody can see it yet. Publishing makes it visible and notifies its audience.'
              : 'Already published. Corrections are visible immediately and nobody is notified again.'
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <Button href={`${detailPath}?edit=1`} variant="secondary" iconLeft="pencil">
              Edit
            </Button>

            {isDraft ? (
              /*
                Confirmed, because publishing is the irreversible half: it
                fires a notification to everyone in the audience and there is
                no un-publish. Deleting afterwards removes the announcement
                but not the bell that already rang.
              */
              <form action={publishAnnouncement}>
                <input type="hidden" name="id" value={announcement.id} />
                <ConfirmSubmit
                  question={`Publish this to ${titleCase(announcement.audience).toLowerCase()}? They will be notified, and it cannot be un-published.`}
                  confirmLabel="Yes, publish it"
                  iconLeft="send"
                >
                  Publish
                </ConfirmSubmit>
              </form>
            ) : null}

            <form action={deleteAnnouncement}>
              <input type="hidden" name="id" value={announcement.id} />
              <ConfirmSubmit
                question={
                  isDraft
                    ? `Delete the draft “${announcement.title}”?`
                    : `Delete “${announcement.title}”? Readers already notified keep their notification.`
                }
                confirmLabel="Yes, delete it"
                iconLeft="trash-2"
              >
                Delete
              </ConfirmSubmit>
            </form>
          </div>
        </Panel>
      }
    >
      {query.published ? (
        <p role="status" style={noticeStyle('success')}>
          Published. Everyone in the {titleCase(announcement.audience).toLowerCase()} audience has
          been notified.
        </p>
      ) : null}
      {errorMessage && !query.edit ? (
        <p role="alert" style={noticeStyle('error')}>
          {errorMessage}
        </p>
      ) : null}

      <Panel
        title="Body"
        description={
          isDraft
            ? 'Not sent to anyone yet.'
            : 'The text as it was sent to the audience. Editing it changes what they read now.'
        }
      >
        <div
          style={{
            whiteSpace: 'pre-wrap',
            color: 'var(--text-primary)',
            fontSize: 'var(--type-body-md-size)',
            lineHeight: 1.6,
          }}
        >
          {announcement.body}
        </div>
      </Panel>

      <Panel title="Schedule">
        <DescriptionList
          items={[
            { label: 'Status', value: status },
            {
              label: 'Published',
              value: announcement.publishedAt ? formatDateTime(announcement.publishedAt) : '—',
            },
            {
              label: 'Expires',
              value: announcement.expiresAt ? formatDateTime(announcement.expiresAt) : 'Never',
            },
            { label: 'Audience', value: titleCase(announcement.audience) },
            { label: 'Author', value: personName(announcement.author) },
          ]}
        />
      </Panel>

      {query.edit ? (
        <Modal open closedHref={detailPath} title="Edit announcement">
          {errorMessage ? (
            <p role="alert" style={{ ...noticeStyle('error'), marginBottom: 'var(--space-5)' }}>
              {errorMessage}
            </p>
          ) : null}
          <form
            action={updateAnnouncement}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
          >
            <input type="hidden" name="id" value={announcement.id} />
            <Field label="Title" htmlFor="edit-title" required>
              <Input
                id="edit-title"
                name="title"
                required
                minLength={3}
                maxLength={200}
                defaultValue={announcement.title}
              />
            </Field>
            <Field label="Body" htmlFor="edit-body" required>
              <Textarea
                id="edit-body"
                name="body"
                rows={10}
                required
                maxLength={10000}
                defaultValue={announcement.body}
              />
            </Field>
            <Field
              label="Expires"
              htmlFor="edit-expires"
              hint="Optional. Clear it to keep the announcement up indefinitely."
            >
              <Input
                id="edit-expires"
                name="expiresAt"
                type="datetime-local"
                defaultValue={toLocalInput(announcement.expiresAt)}
              />
            </Field>
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              The audience stays {titleCase(announcement.audience).toLowerCase()}. It is fixed once
              chosen, because notifications went out to exactly that group — to reach a different
              one, post a separate announcement.
              {isDraft ? '' : ' Editing does not notify anyone again.'}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <SubmitButton variant="primary" iconLeft="save" pendingLabel="Saving…">
                Save changes
              </SubmitButton>
              <Button href={detailPath} variant="secondary">
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </DetailShell>
  )
}

/**
 * An ISO instant as `datetime-local` wants it: `YYYY-MM-DDTHH:mm`, in the
 * SERVER's local time, which is the same reading `createAnnouncement` applies
 * when parsing one back. Returns '' for no expiry, which leaves the field
 * blank rather than showing the epoch.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function noticeStyle(tone: 'success' | 'error') {
  return {
    margin: 0,
    padding: 'var(--space-4) var(--space-5)',
    borderRadius: 'var(--radius-card)',
    background: tone === 'error' ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
    color: tone === 'error' ? 'var(--status-error-fg)' : 'var(--status-success-fg)',
  } as const
}

function audienceTone(audience: string): 'brand' | 'info' | 'accent' | 'neutral' {
  if (audience === 'ALL') return 'brand'
  if (audience === 'CUSTOMERS') return 'info'
  if (audience === 'TESTERS') return 'accent'
  return 'neutral'
}

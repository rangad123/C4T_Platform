'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar } from '@/components/admin/Avatar'
import { TesterPicker } from '@/components/admin/assign/TesterPicker'
import type { Candidate, CandidateMeta, FilterOptions } from '@/components/admin/assign/types'
import { personLabel } from '@/components/admin/assign/types'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { Icon } from '@/components/ds/core/Icon'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import {
  saveDraftAction,
  sendBroadcastAction,
  type ComposeResult,
} from '@/app/app/admin/communication/broadcast-actions'

/**
 * Write a message, choose who gets it, look at it, send it.
 *
 * ── WHY THREE STEPS AND NOT ONE SCREEN
 *
 * The old composer put a textarea above a paginated tester table and used a
 * checkbox column wired to the form by `form="broadcast-form"`. That made
 * selection a property of the current PAGE: filtering or paging silently
 * dropped everyone already ticked, and there was no point at which the sender
 * saw the finished message next to the actual list of people about to receive
 * it. Sending was the first and only confirmation.
 *
 * So: write, then choose, then read it back. The preview step is the one that
 * earns its place — it is the only screen in the flow that shows the message
 * exactly as a tester will read it, alongside every recipient by name, before
 * anything is sent to anyone.
 *
 * ── WHY IT IS ONE CLIENT COMPONENT
 *
 * Everything typed and everything chosen has to survive moving between the
 * steps, and neither belongs in the URL. The steps are state, not routes.
 */

export type ComposeStep = 'write' | 'recipients' | 'preview'

export interface TemplateOption {
  id: string
  name: string
  subject: string | null
  body: string
}

export interface ComposeWorkspaceProps {
  options: FilterOptions
  templates: readonly TemplateOption[]
  initialCandidates: readonly Candidate[]
  initialMeta: CandidateMeta
  /** Set when reopening a saved draft. */
  draft?: {
    id: string
    subject: string | null
    body: string
    templateId: string | null
    recipients: readonly Candidate['user'][]
  } | null
}

const STEPS: readonly { key: ComposeStep; label: string }[] = [
  { key: 'write', label: 'Write' },
  { key: 'recipients', label: 'Recipients' },
  { key: 'preview', label: 'Review and send' },
]

export function ComposeWorkspace({
  options,
  templates,
  initialCandidates,
  initialMeta,
  draft = null,
}: ComposeWorkspaceProps) {
  const router = useRouter()

  const [step, setStep] = useState<ComposeStep>('write')
  const [subject, setSubject] = useState(draft?.subject ?? '')
  const [body, setBody] = useState(draft?.body ?? '')
  const [templateId, setTemplateId] = useState<string>(draft?.templateId ?? '')
  const [broadcastId, setBroadcastId] = useState<string | null>(draft?.id ?? null)

  const [busy, setBusy] = useState<'save' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [result, setResult] = useState<ComposeResult | null>(null)

  /**
   * A reopened draft knows its recipients' names but not their profiles — the
   * broadcast read returns the user, not the tester record. They are seeded as
   * partial candidates so the summary can name them; picking anyone new
   * replaces the entry with the full row from the search.
   */
  const [selected, setSelected] = useState<Map<string, Candidate>>(() => {
    const map = new Map<string, Candidate>()
    for (const user of draft?.recipients ?? []) {
      map.set(user.id, partialCandidate(user))
    }
    return map
  })

  const recipients = useMemo(() => [...selected.values()], [selected])
  const canSend = body.trim().length > 0 && recipients.length > 0

  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id)
      const template = templates.find((t) => t.id === id)
      if (!template) return
      if (template.subject) setSubject(template.subject)
      setBody(template.body)
      setSaved(false)
    },
    [templates],
  )

  const payload = useCallback(
    () => ({
      subject,
      body,
      recipientIds: recipients.map((r) => r.user.id),
      templateId: templateId || null,
      broadcastId,
    }),
    [subject, body, recipients, templateId, broadcastId],
  )

  const save = useCallback(async () => {
    if (busy) return
    setBusy('save')
    setError(null)
    try {
      const outcome = await saveDraftAction(payload())
      if (!outcome.ok) {
        setError(outcome.message ?? 'The draft could not be saved.')
        return
      }
      // Kept, so a second save updates the same draft rather than making
      // another one on every click.
      if (outcome.broadcastId) setBroadcastId(outcome.broadcastId)
      setSaved(true)
    } catch {
      setError('The draft could not be saved. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }, [busy, payload])

  /**
   * Guarded by `busy` rather than only by disabling the button: a double
   * Enter can fire twice before React has re-rendered the disabled state, and
   * the second one would be a second message to everybody.
   */
  const send = useCallback(async () => {
    if (busy || !canSend) return
    setBusy('send')
    setError(null)
    try {
      const outcome = await sendBroadcastAction(payload())
      if (!outcome.ok) {
        if (outcome.broadcastId) setBroadcastId(outcome.broadcastId)
        setError(outcome.message ?? 'The message could not be sent.')
        return
      }
      setResult(outcome)
    } catch {
      setError('The message could not be sent. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }, [busy, canSend, payload])

  if (result?.ok) {
    return (
      <SentPanel
        delivered={result.delivered ?? 0}
        failed={result.failed ?? 0}
        href={`/app/admin/communication/messages/${result.broadcastId}`}
        onComposeAnother={() => {
          setResult(null)
          setSelected(new Map())
          setSubject('')
          setBody('')
          setTemplateId('')
          setBroadcastId(null)
          setSaved(false)
          setStep('write')
          router.refresh()
        }}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <StepBar
        current={step}
        recipientCount={recipients.length}
        onGo={(next) => {
          setError(null)
          setStep(next)
        }}
      />

      {error ? (
        <p role="alert" style={ALERT_STYLE}>
          {error}
        </p>
      ) : null}

      {step === 'write' ? (
        <section aria-label="Write the message" style={PANEL_STYLE}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            {templates.length > 0 ? (
              <Field
                label="Start from a template"
                htmlFor="compose-template"
                hint="Optional. Applying one replaces the subject and message below."
              >
                <Select
                  id="compose-template"
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                  options={[
                    { value: '', label: 'No template' },
                    ...templates.map((t) => ({ value: t.id, label: t.name })),
                  ]}
                />
              </Field>
            ) : null}

            <Field label="Subject" htmlFor="compose-subject" hint="Optional.">
              <Input
                id="compose-subject"
                value={subject}
                maxLength={200}
                placeholder="Update on this week's builds"
                onChange={(e) => {
                  setSubject(e.target.value)
                  setSaved(false)
                }}
              />
            </Field>

            <Field
              label="Message"
              htmlFor="compose-body"
              required
              hint={`${body.length} of 10,000 characters.`}
            >
              <Textarea
                id="compose-body"
                value={body}
                rows={10}
                required
                maxLength={10_000}
                placeholder="What you want every selected tester to know."
                onChange={(e) => {
                  setBody(e.target.value)
                  setSaved(false)
                }}
              />
            </Field>
          </div>

          <Footer
            left={
              <SaveDraft busy={busy} saved={saved} disabled={!body.trim()} onSave={() => void save()} />
            }
            right={
              <Button
                type="button"
                variant="primary"
                iconRight="arrow-right"
                disabled={!body.trim()}
                onClick={() => setStep('recipients')}
              >
                Choose recipients
              </Button>
            }
          />
        </section>
      ) : null}

      {step === 'recipients' ? (
        <>
          <TesterPicker
            endpoint="/app/admin/communication/compose/recipients"
            options={options}
            initialCandidates={initialCandidates}
            initialMeta={initialMeta}
            selected={selected}
            onSelectionChange={(next) => {
              setSelected(next)
              setSaved(false)
            }}
            idPrefix="compose"
            showStatusFilter
            emptyMessage="No testers are available to message yet."
            summaryAction={
              <Button
                type="button"
                variant="primary"
                size="sm"
                iconRight="arrow-right"
                onClick={() => setStep('preview')}
              >
                Review and send
              </Button>
            }
          />
          <Footer
            left={
              <Button
                type="button"
                variant="secondary"
                iconLeft="chevron-left"
                onClick={() => setStep('write')}
              >
                Back to the message
              </Button>
            }
            right={null}
          />
        </>
      ) : null}

      {step === 'preview' ? (
        <section aria-label="Review and send" style={PANEL_STYLE}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <div>
              <h3 style={SECTION_HEADING}>What they will read</h3>
              {/*
                Rendered exactly as a tester sees it in their thread — plain
                text, line breaks preserved, no formatting invented that the
                message does not have.
              */}
              <article style={PREVIEW_STYLE}>
                <strong style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
                  {subject.trim() || 'No subject'}
                </strong>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{body}</p>
              </article>
            </div>

            <div>
              <h3 style={SECTION_HEADING}>
                Going to {recipients.length} tester{recipients.length === 1 ? '' : 's'}
              </h3>
              <p style={{ margin: '0 0 var(--space-4)', color: 'var(--text-secondary)' }}>
                Each one gets a private conversation with you. Nobody sees who else received this,
                and any reply comes back as an ordinary thread.
              </p>
              {recipients.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--status-warning-fg)' }}>
                  No recipients chosen yet.
                </p>
              ) : (
                <ul style={RECIPIENT_LIST}>
                  {recipients.map((r) => (
                    <li key={r.user.id} style={RECIPIENT_CHIP}>
                      <Avatar name={personLabel(r)} fileId={r.user.avatarFileId} size="sm" />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 'var(--fw-medium)' }}>
                          {personLabel(r)}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            color: 'var(--text-secondary)',
                            fontSize: 'var(--type-body-sm-size)',
                          }}
                        >
                          {r.user.email}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${personLabel(r)}`}
                        onClick={() => {
                          const next = new Map(selected)
                          next.delete(r.user.id)
                          setSelected(next)
                          setSaved(false)
                        }}
                        style={REMOVE_BUTTON}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <Footer
            left={
              <span style={{ display: 'inline-flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <Button
                  type="button"
                  variant="secondary"
                  iconLeft="chevron-left"
                  onClick={() => setStep('recipients')}
                >
                  Change recipients
                </Button>
                <SaveDraft
                  busy={busy}
                  saved={saved}
                  disabled={!body.trim()}
                  onSave={() => void save()}
                />
              </span>
            }
            right={
              <Button
                type="button"
                variant="primary"
                iconLeft="send"
                disabled={!canSend || busy !== null}
                onClick={() => void send()}
              >
                {busy === 'send'
                  ? 'Sending…'
                  : `Send to ${recipients.length} tester${recipients.length === 1 ? '' : 's'}`}
              </Button>
            }
          />
        </section>
      ) : null}
    </div>
  )
}

/**
 * The steps, and where you are in them.
 *
 * Clickable backwards only. Jumping to the preview before there is anything
 * to preview would show an empty page and teach nothing.
 */
function StepBar({
  current,
  recipientCount,
  onGo,
}: {
  current: ComposeStep
  recipientCount: number
  onGo: (step: ComposeStep) => void
}) {
  const index = STEPS.findIndex((s) => s.key === current)
  return (
    <ol style={STEP_BAR}>
      {STEPS.map((s, i) => {
        const state = i === index ? 'current' : i < index ? 'done' : 'upcoming'
        return (
          <li key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <button
              type="button"
              disabled={state === 'upcoming'}
              onClick={() => onGo(s.key)}
              aria-current={state === 'current' ? 'step' : undefined}
              style={{
                ...STEP_BUTTON,
                color: state === 'upcoming' ? 'var(--text-muted)' : 'var(--text-primary)',
                fontWeight: state === 'current' ? 'var(--fw-medium)' : 'var(--fw-regular)',
                cursor: state === 'upcoming' ? 'default' : 'pointer',
              }}
            >
              <span style={{ ...STEP_NUMBER, ...(state === 'current' ? STEP_NUMBER_CURRENT : {}) }}>
                {state === 'done' ? <Icon name="check" size={12} /> : i + 1}
              </span>
              {s.label}
              {s.key === 'recipients' && recipientCount > 0 ? (
                <Badge tone="info" uppercase={false}>
                  {recipientCount}
                </Badge>
              ) : null}
            </button>
            {i < STEPS.length - 1 ? (
              <Icon name="chevron-right" size={14} aria-hidden="true" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function SaveDraft({
  busy,
  saved,
  disabled,
  onSave,
}: {
  busy: 'save' | 'send' | null
  saved: boolean
  disabled: boolean
  onSave: () => void
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
      <Button
        type="button"
        variant="secondary"
        iconLeft="save"
        disabled={disabled || busy !== null}
        onClick={onSave}
      >
        {busy === 'save' ? 'Saving…' : 'Save draft'}
      </Button>
      {saved ? (
        <span
          role="status"
          style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}
        >
          Saved.
        </span>
      ) : null}
    </span>
  )
}

/**
 * What happened, in the terms the API actually reports.
 *
 * `delivered` and `failed` are counts of threads created, which is the only
 * delivery fact this platform observes. There is no "pending" here because
 * nothing is pending, and no read count because nobody has had a chance yet.
 */
function SentPanel({
  delivered,
  failed,
  href,
  onComposeAnother,
}: {
  delivered: number
  failed: number
  href: string
  onComposeAnother: () => void
}) {
  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-panel)',
        background: 'var(--surface-raised)',
        padding: 'var(--space-8)',
        textAlign: 'center',
      }}
    >
      <Icon name={failed > 0 ? 'alert-triangle' : 'check'} size={28} style={CENTRED_ICON} />
      <h2 style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--type-body-lg-size)' }}>
        Sent to {delivered} tester{delivered === 1 ? '' : 's'}
      </h2>
      <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--text-secondary)' }}>
        {failed > 0
          ? `${failed} could not be reached — open the message to see which, and why.`
          : 'Each of them now has a private conversation with you and has been notified.'}
      </p>
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          justifyContent: 'center',
          marginTop: 'var(--space-6)',
          flexWrap: 'wrap',
        }}
      >
        <Button href={href} variant="primary">
          View this message
        </Button>
        <Button type="button" variant="secondary" onClick={onComposeAnother}>
          Write another
        </Button>
      </div>
    </section>
  )
}

function Footer({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-4)',
        flexWrap: 'wrap',
        marginTop: 'var(--space-6)',
        paddingTop: 'var(--space-5)',
        borderTop: '1px solid var(--border-subtle)',
      }}
    >
      <span>{left}</span>
      <span>{right}</span>
    </div>
  )
}

/**
 * A saved draft's recipient, shaped as a candidate so the summary can render
 * it with the same row as a freshly picked one. Every field the picker would
 * have filled is empty rather than invented — this is a name and an email,
 * and pretending otherwise would put fabricated ratings on screen.
 */
function partialCandidate(user: Candidate['user']): Candidate {
  return {
    id: user.id,
    status: 'VERIFIED',
    headline: null,
    profession: null,
    city: null,
    countryCode: null,
    experienceYears: null,
    ratingAverage: null,
    ratingCount: 0,
    bugsAcceptedCount: 0,
    projectsCompletedCount: 0,
    user,
    skills: [],
    languages: [],
    devices: [],
    browsers: [],
  }
}

const PANEL_STYLE = {
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-panel)',
  background: 'var(--surface-raised)',
  padding: 'var(--space-6)',
} as const

const ALERT_STYLE = {
  margin: 0,
  padding: 'var(--space-4) var(--space-5)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--status-error-bg)',
  color: 'var(--status-error-fg)',
} as const

const SECTION_HEADING = {
  margin: '0 0 var(--space-3)',
  fontSize: 'var(--type-body-md-size)',
  fontWeight: 'var(--fw-medium)',
} as const

const PREVIEW_STYLE = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--surface-sunken)',
  padding: 'var(--space-5)',
  maxWidth: '68ch',
} as const

const RECIPIENT_LIST = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 'var(--space-3)',
} as const

const RECIPIENT_CHIP = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  padding: 'var(--space-3)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-card)',
  background: 'var(--surface-canvas)',
  minWidth: 0,
} as const

const REMOVE_BUTTON = {
  marginLeft: 'auto',
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  border: 'none',
  borderRadius: 'var(--radius-full)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
} as const

const STEP_BAR = {
  listStyle: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
  margin: 0,
  padding: 0,
} as const

const STEP_BUTTON = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  border: 'none',
  background: 'none',
  padding: 0,
  fontSize: 'var(--type-body-sm-size)',
  fontFamily: 'var(--font-sans)',
} as const

const STEP_NUMBER = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 'var(--radius-full)',
  border: '1px solid var(--border-default)',
  fontSize: 'var(--type-body-sm-size)',
  fontFamily: 'var(--font-mono)',
} as const

/**
 * The full `border` shorthand, not just `borderColor`.
 *
 * React warns — correctly — when a rerender removes a longhand while the
 * shorthand for the same value is also set: the two are applied in object
 * order, so which one wins depends on how the objects happened to be merged.
 * Overriding shorthand with shorthand is unambiguous.
 */
const STEP_NUMBER_CURRENT = {
  border: '1px solid var(--border-strong)',
  background: 'var(--surface-inverse)',
  color: 'var(--text-inverse)',
} as const

/**
 * Centred by `display: inline-block`, not by the parent's `text-align`.
 *
 * Lucide's SVGs compute to `display: block` here, and a block-level child
 * ignores `text-align` on its parent — so the tick sat hard against the left
 * edge of a panel that was otherwise centred. Making it inline-block is what
 * lets the parent's centring reach it.
 */
const CENTRED_ICON = { display: 'inline-block' } as const

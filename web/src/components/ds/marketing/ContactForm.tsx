'use client'

import { useActionState, useEffect, useRef } from 'react'
import { SubmitButton } from '../core/SubmitButton'
import { Icon } from '../core/Icon'
import { Field } from '../forms/Field'
import { Input } from '../forms/Input'
import { PhoneInput } from '../forms/PhoneInput'
import { Select } from '../forms/Select'
import { Textarea } from '../forms/Textarea'
import type { LeadState } from '@/app/(marketing)/contact/actions'

export interface ContactFormProps {
  /** The server action. Passed in so this component stays route-agnostic. */
  action: (prev: LeadState, formData: FormData) => Promise<LeadState>
  title?: string
  description?: string
  submitLabel?: string
  footnote?: string
  teamSizes: readonly string[]
  success: { title: string; body: string }
}

/**
 * The demo-request form. One of the five components CLAUDE.md rule 7 allows to
 * be a client component.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PORT NOTES — THE SOURCE FORM DID NOT SUBMIT ANYTHING.
 *
 * The kit's ContactForm called `preventDefault`, set `sent = true` and showed a
 * thank-you. It was a design artefact, correctly so for a prototype. Four things
 * changed in making it real:
 *
 *  1. It posts to a server action, so it works with JavaScript disabled and
 *     validation cannot be bypassed from devtools. `useActionState` gives the
 *     progressive-enhancement path for free.
 *  2. The success panel renders from the action's return value, not from local
 *     state, so it only appears when the server actually accepted the lead.
 *  3. Server-side field errors are rendered against their inputs. The prototype
 *     had no error path at all.
 *  4. A honeypot field is included. See the action for why it is not a CAPTCHA.
 *
 * The submit button's pending state comes from `SubmitButton` (`useFormStatus`
 * under the hood, reading the enclosing form) rather than `pending` off
 * `useActionState` here in the parent — both work; this one keeps the
 * button's own state local to the button, and is the same shared component
 * every other form's submit button in the app now uses.
 * ──────────────────────────────────────────────────────────────────────────
 */
export function ContactForm({
  action,
  title,
  description,
  submitLabel = 'Request my demo',
  footnote,
  teamSizes,
  success,
}: ContactFormProps) {
  const [state, formAction] = useActionState<LeadState, FormData>(action, { status: 'idle' })
  const successRef = useRef<HTMLDivElement>(null)

  /**
   * Bring the confirmation into view.
   *
   * The success panel is a fraction of the height of the form it replaces, so
   * the page above the reader collapses by several hundred pixels the moment
   * the lead is accepted. The scroll position does not move, so the viewport
   * ends up showing whatever now occupies it — on the landing page, the
   * "What happens on the call" list below — with the confirmation pushed off
   * the top of the screen. The submission worked and looked like it had not.
   *
   * Scrolling rather than focusing keeps the decision the panel documents
   * below: a screen reader still hears `role="status"` announce the
   * confirmation without being thrown out of wherever it was reading.
   */
  useEffect(() => {
    if (state.status !== 'success') return
    const node = successRef.current
    if (!node) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }, [state.status])

  if (state.status === 'success') {
    return (
      <div
        ref={successRef}
        // Announced without stealing focus, so a screen-reader user hears the
        // confirmation where they are rather than being thrown to the top.
        role="status"
        aria-live="polite"
        style={{
          padding: 40,
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-panel)',
          textAlign: 'center',
        }}
      >
        <Icon
          name="check-circle-2"
          size={40}
          style={{ color: 'var(--accent-base)', margin: '0 auto 16px' }}
        />
        <h3
          style={{
            fontSize: 'var(--type-heading-md-size)',
            letterSpacing: 'var(--type-heading-md-tracking)',
          }}
        >
          {success.title}
        </h3>
        <p
          style={{
            marginTop: 10,
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 'var(--type-body-sm-line)',
            color: 'var(--text-secondary)',
          }}
        >
          {success.body}
        </p>
      </div>
    )
  }

  const err = state.errors ?? {}

  return (
    <form
      action={formAction}
      noValidate
      /*
        Sized so the whole form — heading through submit — lands inside the
        first screen on a laptop. It used to run past the fold, which meant the
        button you are asked to press could not be seen without scrolling.
        Tokens rather than the raw 32/16 that were here, per the token rule.
      */
      style={{
        padding: 'var(--space-7)',
        background: 'var(--surface-canvas)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      {title ? (
        <h3
          style={{
            fontSize: 'var(--type-heading-md-size)',
            letterSpacing: 'var(--type-heading-md-tracking)',
          }}
        >
          {title}
        </h3>
      ) : null}

      {description ? (
        <p
          style={{
            fontSize: 'var(--type-body-sm-size)',
            lineHeight: 'var(--type-body-sm-line)',
            color: 'var(--text-secondary)',
            marginTop: -8,
          }}
        >
          {description}
        </p>
      ) : null}

      {state.status === 'error' && state.message ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--status-error-bg)',
            color: 'var(--status-error-fg)',
            fontSize: 'var(--type-body-sm-size)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      <div
        className="c4t-form-row"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}
      >
        <Field label="First name" required htmlFor="fn" error={err.firstName}>
          <Input id="fn" name="firstName" required invalid={Boolean(err.firstName)} />
        </Field>
        <Field label="Last name" required htmlFor="ln" error={err.lastName}>
          <Input id="ln" name="lastName" required invalid={Boolean(err.lastName)} />
        </Field>
      </div>

      <div
        className="c4t-form-row"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}
      >
        <Field label="Work email" required htmlFor="we" error={err.email}>
          <Input
            id="we"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            invalid={Boolean(err.email)}
          />
        </Field>
        {/*
          Required. It used to be optional, on the reasoning that a demo
          request is not worth losing over a phone number — but a booking is
          arranged by call, so the number is what the next step actually
          needs.
        */}
        {/*
          No visible hint. The constraint is unchanged: `PhoneInput` keeps the
          pattern, and `phoneField` on the API is the half that actually
          matters. PHONE_HINT is still attached as the input's `title`, which
          the browser shows alongside its own message when the pattern
          rejects — so the format is explained at the moment someone gets it
          wrong, rather than spending three lines of the first screen on a
          rule most people satisfy without being told.

          Deliberately only here. The admin and portal forms still show the
          hint inline; this is the one form where a visitor is being asked to
          convert and the button had fallen below the fold.
        */}
        <Field label="Contact number" required htmlFor="ph" error={err.phone}>
          <PhoneInput id="ph" name="phone" required invalid={Boolean(err.phone)} />
        </Field>
      </div>

      <div
        className="c4t-form-row"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)' }}
      >
        <Field label="Company" required htmlFor="co" error={err.company}>
          <Input
            id="co"
            name="company"
            autoComplete="organization"
            required
            invalid={Boolean(err.company)}
          />
        </Field>
        <Field label="Team size" htmlFor="ts">
          <Select id="ts" name="size" placeholder="Select" options={teamSizes} />
        </Field>
      </div>

      <Field label="What do you need tested?" htmlFor="msg" error={err.message}>
        <Textarea id="msg" name="message" rows={3} invalid={Boolean(err.message)} />
      </Field>

      {/* Bot trap. Hidden from sight AND from assistive technology, and excluded
          from tab order — a real user can neither see nor reach it, so anything
          that fills it in is automated. `display: none` would be simpler but
          some bots skip hidden inputs; this stays in the layout at zero size. */}
      <div aria-hidden="true" className="c4t-visually-hidden">
        <label htmlFor="hp">Leave this field empty</label>
        <input id="hp" name="honeypot" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <SubmitButton size="lg" fullWidth pendingLabel="Sending…">
        {submitLabel}
      </SubmitButton>

      {footnote ? (
        <p
          style={{
            fontSize: 'var(--type-caption-size)',
            color: 'var(--text-muted)',
            textAlign: 'center',
          }}
        >
          {footnote}
        </p>
      ) : null}
    </form>
  )
}

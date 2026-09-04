import type { ReactNode } from 'react'
import Link from 'next/link'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Icon } from '@/components/ds/core/Icon'
import { AuthDivider, GoogleButton } from '@/components/auth/GoogleButton'
import { registerAction } from '@/lib/auth/register-actions'

/**
 * Self-registration. `/register`
 *
 * TWO ROLES, AND THE CHOICE COMES FIRST.
 * ──────────────────────────────────────────────────────────────────────────
 * A stranger is one of two things to this platform: a customer who wants
 * testing done, or a tester who wants to do it. They need different fields
 * (a customer has an organisation; a tester does not) and they land in
 * different places — a tester's profile is queued for Admin review under §2.2,
 * a customer's organisation is created immediately.
 *
 * So the role is a step, not a dropdown buried in a form. Picking it is a plain
 * link that reloads the page with `?role=`, which keeps this a Server Component
 * with no client state: the choice lives in the URL, so it survives a refresh,
 * a back button and a validation bounce.
 *
 * ADMIN and SUB_ADMIN cannot be self-registered — the API's `intendedRole`
 * schema accepts only these two, so this page cannot be tricked into creating
 * a privileged account by posting a different value.
 */

type SignUpRole = 'customer' | 'tester'

const ROLE_COPY: Record<SignUpRole, { title: string; cta: string; pendingCta: string }> = {
  customer: {
    title: 'Create a customer account',
    cta: 'Create customer account',
    pendingCta: 'Creating account…',
  },
  tester: {
    title: 'Apply to test with us',
    cta: 'Submit application',
    pendingCta: 'Submitting application…',
  },
}

const ERROR_MESSAGES: Record<string, string> = {
  role_required: 'Choose whether you are signing up as a customer or a tester.',
  missing: 'Fill in your name, email and a password to continue.',
  terms: 'You need to accept the Terms of Use to create an account.',
  password_short: 'Use a password of at least 12 characters.',
  organisation_required: 'Enter your company name.',
  email_taken: 'An account with this email already exists. Sign in instead.',
  network: 'Could not reach the sign-up service. Check your connection and retry.',
  validation_error: 'Some details need fixing. Check the form and try again.',
  failed: 'That did not work. Please try again.',
  google_no_account:
    "We don't have an account for that Google email yet. Choose an account type below to create one.",
}

export default async function RegisterForm({
  searchParams,
}: {
  searchParams?: Promise<{
    role?: string
    error?: string
    detail?: string
    email?: string
    firstName?: string
    lastName?: string
    organisationName?: string
    next?: string
  }>
} = {}) {
  const params = searchParams
    ? await searchParams
    : {
        role: undefined,
        error: undefined,
        detail: undefined,
        email: undefined,
        firstName: undefined,
        lastName: undefined,
        organisationName: undefined,
        next: undefined,
      }
  const role: SignUpRole | null =
    params.role === 'customer' || params.role === 'tester' ? params.role : null

  // A field-level message from the API beats our generic copy — it names the
  // actual problem.
  const message: string | null = params.error
    ? params.error === 'field' && params.detail
      ? params.detail
      : (ERROR_MESSAGES[params.error] ?? 'That did not work. Please try again.')
    : null

  return (
    <div>
      {role === null ? (
        <RoleChooser message={message} email={params.email} next={params.next} />
      ) : (
        <SignUpForm role={role} message={message} params={params} />
      )}

      <div
        style={{
          marginTop: 'var(--space-7)',
          paddingTop: 'var(--space-6)',
          borderTop: '1px solid var(--border-default)',
          fontSize: 'var(--type-body-sm-size)',
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        Already have an account?{' '}
        <Link
          href="/login"
          style={{
            color: 'var(--text-brand)',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          Sign in
        </Link>
      </div>
    </div>
  )
}

/* ─── Step 1: which kind of account ──────────────────────────────────────── */

function RoleChooser({
  message,
  email,
  next,
}: {
  message: string | null
  email?: string
  next?: string
}) {
  // Carries the Google email and `next` along so they survive into the form
  // once a role is picked — RoleCard's href is a full navigation, so anything
  // not in the query string here is lost. Losing `next` here would mean
  // someone who followed an invitation link, and had no account, lands on
  // their fresh dashboard after signing up rather than back at the invitation.
  const carry =
    (email ? `&email=${encodeURIComponent(email)}` : '') +
    (next ? `&next=${encodeURIComponent(next)}` : '')

  return (
    <>
      <Link
        href="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          textDecoration: 'none',
          marginBottom: 'var(--space-5)',
        }}
      >
        <Icon name="arrow-left" size={16} />
        Back to home
      </Link>

      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        Create an account
      </h1>

      {message ? <ErrorBanner>{message}</ErrorBanner> : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <RoleCard
          href={`/register?role=customer${carry}`}
          icon="building-2"
          title="I need testing done"
          body="Submit projects, track defects and work with our crowd and AI agents."
          note="Customer account"
        />
        <RoleCard
          href={`/register?role=tester${carry}`}
          icon="users"
          title="I want to test"
          /*
           * The review step moved from the badge into the body. The two badges
           * are a matched pair naming the account type, so one of them carrying
           * a caveat broke the symmetry and made the tester option read as the
           * lesser choice. It still needs saying — a tester who expects instant
           * access and lands in a queue has been misled — so it is said here,
           * in the sentence where expectations belong.
           */
          body="Join the tester community and get matched to paid projects. Applications are reviewed before approval."
          note="Tester account"
        />
      </div>
    </>
  )
}

/** Shared error banner — used both before and after a role is picked. */
function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-5)',
        marginBottom: 'var(--space-6)',
        background: 'var(--status-error-bg)',
        color: 'var(--status-error-fg)',
        borderRadius: 'var(--radius-input)',
        fontSize: 'var(--type-body-sm-size)',
        lineHeight: 1.45,
      }}
    >
      <Icon name="alert-triangle" size={18} style={{ flex: 'none', marginTop: 2 }} />
      <span>{children}</span>
    </div>
  )
}

function RoleCard({
  href,
  icon,
  title,
  body,
  note,
}: {
  href: string
  icon: string
  title: string
  body: string
  note: string
}) {
  return (
    <Link
      href={href}
      className="c4t-card-hover"
      style={{
        display: 'flex',
        gap: 'var(--space-4)',
        padding: 'var(--space-5)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--surface-canvas)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'var(--transition-surface)',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          flex: 'none',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-accent-subtle)',
          color: 'var(--text-accent)',
        }}
      >
        <Icon name={icon} size={20} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        {/*
          The badge leads. It names WHICH account this card creates, and that is
          the thing being chosen — the headline underneath describes the person,
          not the outcome. Reading "CUSTOMER ACCOUNT" first tells you what the
          click does before you parse the sentence.

          Same mono-uppercase treatment as the section eyebrows elsewhere, at
          semibold so it holds its own above the title rather than trailing off
          the bottom of the card as an afterthought.
        */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 'var(--fw-semibold)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-accent)',
            marginBottom: 2,
          }}
        >
          {note}
        </span>
        <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-primary)' }}>
          {title}
        </span>
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
          {body}
        </span>
      </span>
    </Link>
  )
}

/* ─── Step 2: the form for the chosen role ───────────────────────────────── */

function SignUpForm({
  role,
  message,
  params,
}: {
  role: SignUpRole
  message: string | null
  params: {
    email?: string
    firstName?: string
    lastName?: string
    organisationName?: string
    next?: string
  }
}) {
  const copy = ROLE_COPY[role]

  return (
    <>
      <Link
        href={`/register${params.next ? `?next=${encodeURIComponent(params.next)}` : ''}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          textDecoration: 'none',
          marginBottom: 'var(--space-5)',
        }}
      >
        <Icon name="arrow-left" size={16} />
        Change account type
      </Link>

      {/*
        No blurb under the heading. It restated the choice the reader had just
        made on the previous step — "Create a customer account" followed by
        "Submit projects, track defects and work with our testers" — and the
        role cards already carry that description, where it helps decide.
      */}
      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-7)' }}>
        {copy.title}
      </h1>

      {message ? <ErrorBanner>{message}</ErrorBanner> : null}

      {/*
        The role rides along so a new Google account is created as the right
        kind. An EXISTING Google account ignores it and signs into whatever it
        already is — the role only decides what to create.
      */}
      <GoogleButton role={role} next={params.next} label="Sign up with Google" intent="register" />

      <AuthDivider />

      <form
        action={registerAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <input type="hidden" name="role" value={role} />
        <input type="hidden" name="next" value={params.next ?? ''} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <Field label="First name" htmlFor="firstName" required>
            <Input
              id="firstName"
              name="firstName"
              autoComplete="given-name"
              required
              defaultValue={params.firstName ?? ''}
            />
          </Field>
          <Field label="Last name" htmlFor="lastName">
            <Input
              id="lastName"
              name="lastName"
              autoComplete="family-name"
              defaultValue={params.lastName ?? ''}
            />
          </Field>
        </div>

        {/* Email and password pair up, the same as the two name fields — the
            dialog is wide enough for both and it keeps the form to four rows
            instead of six. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <Field label="Work email" htmlFor="email" required>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue={params.email ?? ''}
              placeholder="you@company.com"
              iconLeft="mail"
            />
          </Field>

          <Field label="Password" htmlFor="password" required hint="At least 12 characters.">
            {/*
              Every other password field in the app can be revealed; this one
              could not. Sign-up is where it matters most — the field asks for
              at least twelve characters, autocomplete has nothing to offer on
              a new account, and there is no second field to catch a typo.
            */}
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              iconLeft="lock"
              showPasswordToggle
            />
          </Field>
        </div>

        {role === 'customer' ? (
          <Field label="Company" htmlFor="organisationName" required>
            <Input
              id="organisationName"
              name="organisationName"
              required
              defaultValue={params.organisationName ?? ''}
              placeholder="Acme Ltd"
              iconLeft="building-2"
            />
          </Field>
        ) : null}

        {/*
          One line, not two. The second line repeated the first almost word for
          word — "I accept the Terms of Use and Privacy Policy" above "Read the
          Terms of Use and Privacy Policy" — so the documents are simply linked
          where they are named.

          `labelSuffix` rather than putting anchors in `label`: that prop keeps
          the announced name the plain sentence and the links individually
          focusable beside it, which is the reason the two were split apart in
          the first place.
        */}
        <Checkbox
          id="acceptedTerms"
          name="acceptedTerms"
          required
          label="I accept the"
          labelSuffix={
            <>
              <Link href="/legal/terms" style={{ color: 'var(--text-brand)' }}>
                Terms of Use
              </Link>{' '}
              and{' '}
              <Link href="/legal/privacy" style={{ color: 'var(--text-brand)' }}>
                Privacy Policy
              </Link>
              .
            </>
          }
          aria-label="I accept the Terms of Use and Privacy Policy"
        />

        <SubmitButton
          variant="primary"
          size="lg"
          fullWidth
          iconRight="arrow-right"
          pendingLabel={copy.pendingCta}
        >
          {copy.cta}
        </SubmitButton>
      </form>
    </>
  )
}

import Link from 'next/link'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { Button } from '@/components/ds/core/Button'
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

const ROLE_COPY: Record<SignUpRole, { title: string; blurb: string; cta: string }> = {
  customer: {
    title: 'Create a customer account',
    blurb: 'Submit projects, track defects and work with our testers.',
    cta: 'Create customer account',
  },
  tester: {
    title: 'Apply to test with us',
    blurb:
      'Join the tester community. Applications are reviewed before you are matched to projects.',
    cta: 'Submit application',
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
  }>
} = {}) {
  const params = searchParams
    ? await searchParams
    : { role: undefined, error: undefined, detail: undefined, email: undefined, firstName: undefined, lastName: undefined, organisationName: undefined }
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
      {role === null ? <RoleChooser /> : <SignUpForm role={role} message={message} params={params} />}

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

function RoleChooser() {
  return (
    <>
      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        Create an account
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          marginBottom: 'var(--space-7)',
        }}
      >
        Tell us which describes you.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <RoleCard
          href="/register?role=customer"
          icon="building-2"
          title="I need testing done"
          body="Submit projects, track defects and work with our crowd and AI agents."
          note="Customer account"
        />
        <RoleCard
          href="/register?role=tester"
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
        padding: 'var(--space-6)',
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
  params: { email?: string; firstName?: string; lastName?: string; organisationName?: string }
}) {
  const copy = ROLE_COPY[role]

  return (
    <>
      <Link
        href="/register"
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

      <h1 className="c4t-heading-lg" style={{ marginBottom: 'var(--space-3)' }}>
        {copy.title}
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--type-body-sm-size)',
          marginBottom: 'var(--space-7)',
        }}
      >
        {copy.blurb}
      </p>

      {message ? (
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
          <span>{message}</span>
        </div>
      ) : null}

      {/*
        The role rides along so a new Google account is created as the right
        kind. An EXISTING Google account ignores it and signs into whatever it
        already is — the role only decides what to create.
      */}
      <GoogleButton role={role} label="Sign up with Google" />

      <AuthDivider />

      <form
        action={registerAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
      >
        <input type="hidden" name="role" value={role} />

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

        <Field
          label="Password"
          htmlFor="password"
          required
          hint="At least 12 characters. Length beats complexity."
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            iconLeft="lock"
          />
        </Field>

        {/*
          The consent links sit BESIDE the checkbox, not inside its label.
          `Checkbox` takes `label` as a string, deliberately — a control label
          is announced as one string by assistive tech, and burying anchors in
          it produces a label that reads as a run-on sentence and traps focus
          between the box and the links. So the box carries the plain sentence
          and the documents are linked underneath, where they are reachable in
          their own right.
        */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Checkbox
            name="acceptedTerms"
            required
            label="I accept the Terms of Use and Privacy Policy"
          />
          <span
            style={{
              fontSize: 'var(--type-caption-size)',
              color: 'var(--text-muted)',
              paddingLeft: 28,
            }}
          >
            Read the{' '}
            <Link href="/legal/terms" style={{ color: 'var(--text-brand)' }}>
              Terms of Use
            </Link>{' '}
            and{' '}
            <Link href="/legal/privacy" style={{ color: 'var(--text-brand)' }}>
              Privacy Policy
            </Link>
            .
          </span>
        </div>

        <Button type="submit" variant="primary" size="lg" fullWidth iconRight="arrow-right">
          {copy.cta}
        </Button>
      </form>
    </>
  )
}

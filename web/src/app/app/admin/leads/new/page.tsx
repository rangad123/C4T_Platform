import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Checkbox } from '@/components/ds/forms/Checkbox'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { PhoneInput, PHONE_HINT } from '@/components/ds/forms/PhoneInput'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requirePermission } from '@/lib/auth/session'
import { createLeadAction } from '@/lib/admin/lead-actions'
import { CONTACT_FORM } from '@/content/pages'

/**
 * `/app/admin/leads/new` — enter an enquiry that did not come through the
 * website form.
 *
 * The fields are the demo form's fields, deliberately and in the same order.
 * A lead entered after a phone call and a lead submitted at 2am should be the
 * same shape of record, or the pipeline is two datasets that only look like
 * one — and anyone reading the list has to know which kind they are looking at
 * before they can trust a column.
 *
 * `teamSizes` and the consent wording come from `CONTACT_FORM`, the same
 * module the marketing form reads, so the options cannot drift apart.
 *
 * Not collected here: status and notes. Both exist on the detail page this
 * redirects to, which is where triage belongs — a new lead is NEW, and a
 * second place to set that is a second place for it to be set wrongly.
 */
const TEAM_SIZE_OPTIONS = [
  { value: '', label: 'Not specified' },
  ...CONTACT_FORM.teamSizes.map((size) => ({ value: size, label: size })),
]

const ERRORS: Record<string, string> = {
  invalid: 'Some values were not accepted. Check the fields and try again.',
  forbidden: 'You do not have permission to add leads.',
  failed: "Couldn't add the lead. Try again in a moment.",
}

export default async function NewLeadPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requirePermission('lead.write')
  const params = await searchParams

  return (
    <DetailShell
      crumbs={[{ label: 'Leads', href: '/app/admin/leads' }, { label: 'New' }]}
      eyebrow="Pipeline"
      title="Add lead"
      subtitle="For an enquiry that arrived by phone, email or in person. It lands in the same inbox as the website's demo requests."
    >
      <Panel
        title="Enquiry"
        description="The same details the demo request form collects. Only the name, email and company are required."
      >
        {params.error ? (
          <div
            role="alert"
            style={{
              marginBottom: 'var(--space-6)',
              padding: 'var(--space-4) var(--space-5)',
              border: '1px solid var(--status-error-fg)',
              borderRadius: 'var(--radius-input)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              fontSize: 'var(--type-body-sm-size)',
              lineHeight: 1.45,
            }}
          >
            {ERRORS[params.error] ?? ERRORS.failed}
          </div>
        ) : null}

        <TrackedForm action={createLeadAction} style={formStyle}>
          <div style={fieldGrid}>
            <Field label="First name" htmlFor="firstName" required>
              <Input id="firstName" name="firstName" maxLength={80} required autoComplete="off" />
            </Field>
            <Field label="Last name" htmlFor="lastName" required>
              <Input id="lastName" name="lastName" maxLength={80} required autoComplete="off" />
            </Field>
          </div>

          <div style={fieldGrid}>
            <Field label="Work email" htmlFor="email" required>
              <Input
                id="email"
                name="email"
                type="email"
                maxLength={200}
                required
                autoComplete="off"
                placeholder="name@company.com"
              />
            </Field>
            <Field label="Contact number" htmlFor="phone" hint={PHONE_HINT}>
              <PhoneInput id="phone" name="phone" autoComplete="off" />
            </Field>
          </div>

          <div style={fieldGrid}>
            <Field label="Company" htmlFor="company" required>
              <Input id="company" name="company" maxLength={160} required autoComplete="off" />
            </Field>
            <Field label="Team size" htmlFor="teamSize">
              <Select id="teamSize" name="teamSize" options={TEAM_SIZE_OPTIONS} />
            </Field>
          </div>

          <Field
            label="What do you need tested?"
            htmlFor="message"
            hint="A sentence is plenty — whatever they told you."
          >
            <Textarea id="message" name="message" rows={4} maxLength={4000} />
          </Field>

          {/*
            Consent is evidence, not a preference: it is stored as given rather
            than inferred later, so it is only ticked here if they actually
            said yes.
          */}
          <Checkbox name="marketingConsent" label={CONTACT_FORM.consentLabel} />

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <SubmitButton variant="primary" iconLeft="check" pendingLabel="Adding lead…">
              Add lead
            </SubmitButton>
            <Button type="button" variant="ghost" href="/app/admin/leads">
              Cancel
            </Button>
          </div>
        </TrackedForm>
      </Panel>
    </DetailShell>
  )
}

const formStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-6)',
}

const fieldGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 'var(--space-5) var(--space-6)',
}

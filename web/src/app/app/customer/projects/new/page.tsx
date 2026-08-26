import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requireRole } from '@/lib/auth/session'
import { titleCase } from '@/lib/admin/format'
import { createProjectAction } from '../actions'

const ROOT = { label: 'Customer', href: '/app/customer' }
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
const PRIORITY_OPTIONS = PRIORITIES.map((value) => ({ value, label: titleCase(value) }))
const COMMON_PLATFORMS = ['android', 'ios', 'web', 'desktop'] as const

/**
 * `/app/customer/projects/new` — submit a new test cycle.
 *
 * No organisation picker, unlike `admin/projects/new/page.tsx`: the API's
 * `resolveOrganisationId` infers the org from the caller's own membership
 * for a CUSTOMER request, since a customer only ever creates a project for
 * their own organisation.
 */
export default async function NewCustomerProjectPage() {
  await requireRole(['CUSTOMER'])

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Projects', href: '/app/customer/projects' }, { label: 'New' }]}
      eyebrow="Delivery"
      title="New project"
      subtitle="Start date defaults to today; end date to one month later."
    >
      <Panel title="Profile" description="The minimum needed to open a project.">
        <TrackedForm action={createProjectAction} style={formStyle}>
          <Field label="Title" htmlFor="title" required hint="A short, descriptive name.">
            <Input id="title" name="title" required maxLength={200} />
          </Field>

          <Field
            label="Summary"
            htmlFor="summary"
            hint="One paragraph. Shown on the project list — testers read this to decide whether to pick it up."
          >
            <Textarea id="summary" name="summary" rows={3} maxLength={2000} />
          </Field>

          <Field label="Instructions" htmlFor="instructions" hint="Detailed scope. Testers see this when they open the project.">
            <Textarea id="instructions" name="instructions" rows={6} maxLength={20000} />
          </Field>

          <div style={fieldGrid}>
            <Field label="Priority" htmlFor="priority">
              <Select id="priority" name="priority" defaultValue="NORMAL" options={PRIORITY_OPTIONS} />
            </Field>
            <Field label="Start date" htmlFor="startDate" hint="Leave blank to start today.">
              <Input id="startDate" name="startDate" type="date" />
            </Field>
            <Field label="End date" htmlFor="endDate" hint="Leave blank to keep the project open.">
              <Input id="endDate" name="endDate" type="date" />
            </Field>
            <Field label="Maximum testers" htmlFor="maxTesters" hint="Leave blank for no cap.">
              <Input id="maxTesters" name="maxTesters" type="number" min={1} max={10000} />
            </Field>
          </div>

          <Panel
            title="Targets"
            description="Where the project runs. Comma-separated values are simpler than picking chips and they round-trip to the API as strings."
          >
            <div style={fieldGrid}>
              <Field label="Platforms" htmlFor="platformTargets" hint={`Common values: ${COMMON_PLATFORMS.join(', ')}. Comma-separated.`}>
                <Input id="platformTargets" name="platformTargets" placeholder="android, ios" />
              </Field>
              <Field label="Countries" htmlFor="targetCountries" hint="ISO 3166-1 alpha-2 country codes. Comma-separated.">
                <Input id="targetCountries" name="targetCountries" placeholder="IN, US" />
              </Field>
              <Field label="Languages" htmlFor="targetLanguages" hint="ISO 639-1 two-letter codes. Comma-separated.">
                <Input id="targetLanguages" name="targetLanguages" placeholder="en, hi" />
              </Field>
            </div>
          </Panel>

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <SubmitButton variant="primary" iconLeft="check" pendingLabel="Creating project…">
              Create project
            </SubmitButton>
            <Button href="/app/customer/projects" type="button" variant="ghost">
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

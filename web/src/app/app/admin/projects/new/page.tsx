import Link from 'next/link'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requirePermission } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { createProjectAction } from '@/lib/admin/project-actions'
import { titleCase } from '@/lib/admin/format'

/**
 * `/app/admin/projects/new` — create a project on behalf of any organisation.
 *
 * Customers normally create their own projects through their portal. This page
 * exists for the cases where they cannot — a sales-assisted onboarding, an
 * admin mock-up of a complex project, or a project brought in from a
 * non-custom platform. As admin, the organisation must be picked from the
 * list (the API infers it from the requester's membership for a customer).
 *
 * `platformTargets` / `targetCountries` / `targetLanguages` are comma-separated
 * rather than multi-select widgets, because that is what the data really is
 * and the multi-select UI would add client state for a form that otherwise
 * needs none.
 */
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
const PRIORITY_OPTIONS = PRIORITIES.map((value) => ({ value, label: titleCase(value) }))

const COMMON_PLATFORMS = ['android', 'ios', 'web', 'desktop'] as const

interface OrganisationOption {
  id: string
  name: string
}

export default async function NewProjectPage() {
  await requirePermission('project.write')

  /**
   * The list of organisations an admin can choose from. Failures are
   * swallowed and presented as an empty list + warning rather than a hard
   * error — the admin can still hand-type the cuid if they have it.
   */
  let organisations: readonly { id: string; name: string }[] = []
  let orgLoadFailed = false
  try {
    const response = await serverFetchPage<OrganisationOption>('organisations', {
      query: { limit: 200, status: 'ACTIVE' },
    })
    organisations = response.data
  } catch {
    orgLoadFailed = true
  }

  const orgOptions = organisations.map((o) => ({ value: o.id, label: o.name }))

  return (
    <DetailShell
      crumbs={[
        { label: 'Projects', href: '/app/admin/projects' },
        { label: 'New' },
      ]}
      eyebrow="Delivery"
      title="New project"
      subtitle="A test cycle on behalf of a customer. The reference, status, and creator are set by the platform."
    >
      <Panel
        title="Profile"
        description="The minimum needed to open a project. Start date defaults to today; end date to one month later."
      >
        <TrackedForm action={createProjectAction} style={formStyle}>
          <Field
            label="Organisation"
            htmlFor="organisationId"
            required
            hint={
              orgLoadFailed
                ? 'The organisation list could not be loaded. Paste a cuid directly if you have one.'
                : `${orgOptions.length} active organisations available.`
            }
          >
            <Select
              id="organisationId"
              name="organisationId"
              defaultValue=""
              placeholder="Pick an organisation"
              options={orgOptions}
            />
          </Field>

          <Field
            label="Title"
            htmlFor="title"
            required
            hint="A short, descriptive name. Visible to anyone with the project link."
          >
            <Input id="title" name="title" required maxLength={200} />
          </Field>

          <Field
            label="Summary"
            htmlFor="summary"
            hint="One paragraph. Shown on the project list — testers read this to decide whether to pick it up."
          >
            <Textarea id="summary" name="summary" rows={3} maxLength={2000} />
          </Field>

          <Field
            label="Instructions"
            htmlFor="instructions"
            hint="Detailed scope. Testers see this when they open the project."
          >
            <Textarea id="instructions" name="instructions" rows={6} maxLength={20000} />
          </Field>

          <div style={fieldGrid}>
            <Field label="Priority" htmlFor="priority">
              <Select
                id="priority"
                name="priority"
                defaultValue="NORMAL"
                options={PRIORITY_OPTIONS}
              />
            </Field>
            <Field
              label="Start date"
              htmlFor="startDate"
              hint="Leave blank to start today."
            >
              <Input id="startDate" name="startDate" type="date" />
            </Field>
            <Field
              label="End date"
              htmlFor="endDate"
              hint="Leave blank to keep the project open."
            >
              <Input id="endDate" name="endDate" type="date" />
            </Field>
            <Field
              label="Maximum testers"
              htmlFor="maxTesters"
              hint="Leave blank for no cap."
            >
              <Input id="maxTesters" name="maxTesters" type="number" min={1} max={10000} />
            </Field>
          </div>

          <Panel
            title="Targets"
            description="Where the project runs. Comma-separated values are simpler than picking chips and they round-trip to the API as strings."
          >
            <div style={fieldGrid}>
              <Field
                label="Platforms"
                htmlFor="platformTargets"
                hint={`Common values: ${COMMON_PLATFORMS.join(', ')}. Comma-separated.`}
              >
                <Input id="platformTargets" name="platformTargets" placeholder="android, ios" />
              </Field>
              <Field
                label="Countries"
                htmlFor="targetCountries"
                hint="ISO 3166-1 alpha-2 country codes. IN, US, GB, etc. Comma-separated."
              >
                <Input id="targetCountries" name="targetCountries" placeholder="IN, US" />
              </Field>
              <Field
                label="Languages"
                htmlFor="targetLanguages"
                hint="ISO 639-1 two-letter codes. en, hi, es, etc. Comma-separated."
              >
                <Input id="targetLanguages" name="targetLanguages" placeholder="en, hi" />
              </Field>
            </div>
          </Panel>

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Button type="submit" variant="primary" iconLeft="check">
              Create project
            </Button>
            <Link href="/app/admin/projects">
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </Link>
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

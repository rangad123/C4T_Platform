import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { Textarea } from '@/components/ds/forms/Textarea'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requirePermission } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { createProjectAction } from '@/lib/admin/project-actions'
import { TEST_TYPE_OPTIONS } from '@/lib/testing/test-types'
import { titleCase } from '@/lib/admin/format'
import { MultiSelect } from '@/components/admin/MultiSelect'
import { loadTargetOptions } from '@/lib/catalog/target-options'
import { countryOptions } from '@/lib/geo/source'

/**
 * `/app/admin/projects/new` — create a project on behalf of any organisation.
 *
 * Customers normally create their own projects through their portal. This page
 * exists for the cases where they cannot — a sales-assisted onboarding, an
 * admin mock-up of a complex project, or a project brought in from a
 * non-custom platform. As admin, the organisation must be picked from the
 * list (the API infers it from the requester's membership for a customer).
 *
 * `platformTargets` / `targetCountries` / `targetLanguages` are pickers.
 *
 * They used to be comma-separated text, on the argument that the stored data
 * is a list of strings and a multi-select would add client state to a form
 * that otherwise needs none. Both halves were true and neither was the point:
 * the values are drawn from fixed vocabularies — ISO 3166, ISO 639, and four
 * platform names — so the text box was asking the reader to recall codes and
 * accepting anything they typed. `MultiSelect` posts one hidden input per
 * value, which is still a plain string list to the API.
 */
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
const PRIORITY_OPTIONS = PRIORITIES.map((value) => ({ value, label: titleCase(value) }))

interface OrganisationOption {
  id: string
  name: string
}

const CREATE_ERRORS: Record<string, string> = {
  forbidden: 'You do not have permission to create a project for that organisation.',
  invalid: 'Some values were not accepted. Check the organisation, dates and targets.',
  failed: 'The project could not be created. Try again in a moment.',
}

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requirePermission('project.write')

  const { error } = await searchParams
  const createError = error ? (CREATE_ERRORS[error] ?? CREATE_ERRORS.failed) : null

  /**
   * The list of organisations an admin can choose from. Failures are
   * swallowed and presented as an empty list + warning rather than a hard
   * error — the admin can still hand-type the cuid if they have it.
   */
  let organisations: readonly { id: string; name: string }[] = []
  let orgLoadFailed = false
  try {
    const response = await serverFetchPage<OrganisationOption>('organisations', {
      // 100 is the API's ceiling (`paginationQuery`). Asking for 200 was a
      // silent 422 that the catch below turned into an empty list, so the
      // picker offered nothing and read as "this platform has no
      // organisations" rather than "that request was rejected".
      query: { limit: 100, status: 'ACTIVE' },
    })
    organisations = response.data
  } catch {
    orgLoadFailed = true
  }

  const orgOptions = organisations.map((o) => ({ value: o.id, label: o.name }))

  /* Platform and language vocabularies from the one shared source. */
  const targets = await loadTargetOptions()

  return (
    <DetailShell
      crumbs={[{ label: 'Projects', href: '/app/admin/projects' }, { label: 'New' }]}
      eyebrow="Delivery"
      title="New project"
      subtitle="A test cycle on behalf of a customer. The reference, status, and creator are set by the platform."
    >
      <Panel
        title="Profile"
        description="The minimum needed to open a project. Start date defaults to today; end date to one month later."
      >
        <TrackedForm action={createProjectAction} style={formStyle}>
          {createError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                padding: 'var(--space-4) var(--space-5)',
                borderRadius: 'var(--radius-card)',
                background: 'var(--status-error-bg)',
                color: 'var(--status-error-fg)',
              }}
            >
              {createError}
            </p>
          ) : null}
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

          {/*
            Type of testing is a BUILD field, not a project one — the customer
            wizard collects it here too and applies it to the build the create
            makes. Offered on this form for the same reason: an admin opening a
            project on a customer's behalf is describing the same test cycle,
            and leaving it out meant every admin-created project started with
            its type unset and no prompt to set one.
          */}
          <div style={fieldGrid}>
            <Field label="Type of testing" htmlFor="testType">
              <Select id="testType" name="testType" defaultValue="" options={TEST_TYPE_OPTIONS} />
            </Field>
            <Field label="Priority" htmlFor="priority">
              <Select
                id="priority"
                name="priority"
                defaultValue="NORMAL"
                options={PRIORITY_OPTIONS}
              />
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

          <Panel title="Targets" description="Where the project runs.">
            <div style={fieldGrid}>
              {/* Three comma-separated code boxes became three pickers. The
                  hints used to have to teach ISO 3166 and ISO 639 because the
                  reader was expected to recall a code; now they choose a name. */}
              <Field
                label="Platforms"
                htmlFor="platformTargets"
                hint="The platforms this project is tested on."
              >
                <MultiSelect
                  id="platformTargets"
                  name="platformTargets"
                  options={targets.platforms}
                  max={40}
                />
              </Field>
              <Field
                label="Countries"
                htmlFor="targetCountries"
                hint="Search and add. Leave empty for any country."
              >
                <MultiSelect
                  id="targetCountries"
                  name="targetCountries"
                  options={countryOptions()}
                  max={40}
                />
              </Field>
              <Field
                label="Languages"
                htmlFor="targetLanguages"
                hint="Search and add. Leave empty for any language."
              >
                <MultiSelect
                  id="targetLanguages"
                  name="targetLanguages"
                  options={targets.languages}
                  max={40}
                />
              </Field>
            </div>
          </Panel>

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <SubmitButton variant="primary" iconLeft="check" pendingLabel="Creating project…">
              Create project
            </SubmitButton>
            <Button href="/app/admin/projects" type="button" variant="ghost">
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

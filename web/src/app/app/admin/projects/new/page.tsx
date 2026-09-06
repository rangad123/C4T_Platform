import { ProjectWizard, type WizardParams } from '@/components/projects/ProjectWizard'
import { requirePermission } from '@/lib/auth/session'
import { serverFetchPage } from '@/lib/api/server'
import { titleCase } from '@/lib/admin/format'
import { PROJECT_PRIORITIES } from '@/lib/domain/enums'
import { createProjectFromWizardAsAdmin } from './actions'

/**
 * `/app/admin/projects/new` — create a project on behalf of any organisation.
 *
 * Customers normally create their own projects through their portal. This page
 * exists for the cases where they cannot — a sales-assisted onboarding, an
 * admin mock-up of a complex project, or a project brought in from another
 * platform.
 *
 * ── WHY THIS IS NOW THE SAME WIZARD
 *
 * It used to be a flat, single-page form of its own. It collected twelve
 * fields where the customer wizard collects twenty, and it never touched the
 * project's first build — so a project created here arrived with an empty
 * build that somebody had to go and fill in. Two forms for one job, already
 * that far apart. Both portals now render
 * `components/projects/ProjectWizard`, so a field added for one is a field
 * both have.
 *
 * The only admin difference is the two props below: the organisation the
 * project belongs to (a customer's is resolved from their membership) and its
 * priority (internal triage).
 */

interface OrganisationOption {
  id: string
  name: string
}

export default async function NewProjectAsAdminPage({
  searchParams,
}: {
  searchParams: Promise<WizardParams>
}) {
  await requirePermission('project.write')
  const params = await searchParams

  /**
   * Failures are swallowed into an empty list rather than a hard error. The
   * wizard still renders, the organisation select is simply empty, and the
   * step's own `required` refuses to advance — which is a better failure than
   * a page that will not open at all.
   */
  let organisations: readonly OrganisationOption[] = []
  try {
    const response = await serverFetchPage<OrganisationOption>('organisations', {
      // 100 is the API's ceiling (`paginationQuery`).
      query: { limit: 100, status: 'ACTIVE' },
    })
    organisations = response.data
  } catch {
    organisations = []
  }

  return (
    <ProjectWizard
      basePath="/app/admin/projects/new"
      uploadPath="/app/admin/upload"
      root={{ label: 'Admin', href: '/app/admin' }}
      projectsHref="/app/admin/projects"
      action={createProjectFromWizardAsAdmin}
      params={params}
      organisations={organisations}
      priorities={PROJECT_PRIORITIES.map((value) => ({ value, label: titleCase(value) }))}
    />
  )
}

import { requireRole } from '@/lib/auth/session'
import { ProjectWizard, type WizardParams } from '@/components/projects/ProjectWizard'
import { createProjectFromWizard } from './actions'

/**
 * `/app/customer/projects/new` — set up a test.
 *
 * The wizard itself is `components/projects/ProjectWizard`, shared with the
 * Admin portal so the two cannot offer different fields for the same job.
 * What is customer-specific is here: the role gate, the upload route, the
 * breadcrumb, and the action.
 *
 * No `organisations` or `priorities` prop, deliberately. A customer belongs to
 * one organisation and the API resolves it from their membership, so a picker
 * would offer a choice they do not have; priority is internal triage.
 */
export default async function NewProjectWizardPage({
  searchParams,
}: {
  searchParams: Promise<WizardParams>
}) {
  await requireRole(['CUSTOMER'])
  const params = await searchParams

  return (
    <ProjectWizard
      basePath="/app/customer/projects/new"
      uploadPath="/app/customer/upload"
      root={{ label: 'Customer', href: '/app/customer' }}
      projectsHref="/app/customer/projects"
      action={createProjectFromWizard}
      params={params}
    />
  )
}

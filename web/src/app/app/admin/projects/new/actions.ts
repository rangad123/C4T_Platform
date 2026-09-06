'use server'

import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { isProjectPriority } from '@/app/app/admin/projects/[id]/constants'
import { createProjectFromWizard } from '@/lib/projects/create-from-wizard'

/**
 * Create a project from the wizard, as an admin.
 *
 * The sequence is shared with the Customer portal — see
 * `lib/projects/create-from-wizard`. What is admin-specific is here: the
 * permission gate, this portal's paths, and the two extra project-level
 * fields an admin may set.
 *
 * `organisationId` is not defaulted or guessed. For a customer the API
 * resolves it from their membership; an admin is acting on somebody else's
 * behalf, so an absent one has no sensible fallback and the wizard's own
 * `required` is what stops it getting this far.
 */
export async function createProjectFromWizardAsAdmin(formData: FormData): Promise<void> {
  await requirePermission('project.write')

  const organisationId = formTrimmed(formData, 'organisationId')
  const priority = formTrimmed(formData, 'priority')

  await createProjectFromWizard(formData, {
    wizardPath: '/app/admin/projects/new',
    projectHref: (id) => `/app/admin/projects/${id}`,
    revalidate: ['/app/admin/projects', '/app/admin'],
    extra: {
      ...(organisationId ? { organisationId } : {}),
      // Checked rather than passed through: the value reaches the action from
      // a query string, and an unrecognised one would be a 422 the wizard
      // could only report as "some values were not accepted".
      ...(isProjectPriority(priority) ? { priority } : {}),
    },
  })
}

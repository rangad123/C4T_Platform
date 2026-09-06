'use server'

import { requireRole } from '@/lib/auth/session'
import { createProjectFromWizard as run } from '@/lib/projects/create-from-wizard'

/**
 * Create a project from the wizard, as a customer.
 *
 * The sequence lives in `lib/projects/create-from-wizard` and is shared with
 * the Admin portal — see that file for why. What stays here is the part that
 * is genuinely this portal's: the role gate, and its own paths.
 *
 * No `extra`. A customer does not choose the organisation — the API resolves
 * it from their membership, and a 403 or 400 from that resolution is already
 * mapped to a message the wizard shows.
 */
export async function createProjectFromWizard(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  await run(formData, {
    wizardPath: '/app/customer/projects/new',
    projectHref: (id) => `/app/customer/projects/${id}`,
    revalidate: ['/app/customer/projects', '/app/customer'],
  })
}

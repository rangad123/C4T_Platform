'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

const WIZARD = '/app/customer/projects/new'

/** A build as the project detail returns it. */
interface BuildRow {
  id: string
  name: string
  isDefault: boolean
}

interface CreatedProject {
  id: string
  reference: string
  builds?: readonly BuildRow[]
}

/**
 * Creates the project and its first build from the finished wizard.
 *
 * ── WHY THREE CALLS
 *
 * `POST /projects` creates the project AND one default build named "Original
 * build" — that is existing behaviour every other caller relies on, so the
 * wizard works with it rather than around it. The project-level fields go in
 * on create; then the default build is found and PATCHed with the build-level
 * ones (its real version name, the app URL, the test document, the OS and
 * browser targeting). `updateBuildSchema` already accepts every one of those,
 * so no new endpoint was needed.
 *
 * The project id is returned by the create, but the BUILD id is not —
 * `projectSelect` does not include builds — hence the detail read in between.
 *
 * ── ON PARTIAL FAILURE
 *
 * If the build PATCH fails the project still exists, as a DRAFT with its first
 * build unconfigured. That is recoverable in the UI (the build details form
 * edits exactly these fields) and is much better than the alternative: there
 * is no transaction spanning three HTTP calls, so the only way to "roll back"
 * would be to delete a project the user may have wanted. So the redirect still
 * goes to the project, carrying a notice that the build needs finishing.
 */
export async function createProjectFromWizard(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const title = formTrimmed(formData, 'title')
  const buildName = formTrimmed(formData, 'buildName')
  const appUrl = formTrimmed(formData, 'appUrl')
  const maxTestersRaw = formTrimmed(formData, 'maxTesters')
  const startDate = formTrimmed(formData, 'startDate')
  const endDate = formTrimmed(formData, 'endDate')
  const logoFileId = formTrimmed(formData, 'logoFileId')

  const testType = formTrimmed(formData, 'testType')
  const testDocumentFileId = formTrimmed(formData, 'testDocumentFileId')
  const instructions = formTrimmed(formData, 'instructions')
  const specialRequirements = formTrimmed(formData, 'specialRequirements')

  const platformTargets = formData.getAll('platformTargets').map(String).filter(Boolean)
  const targetCountries = formData.getAll('targetCountries').map(String).filter(Boolean)
  const targetLanguages = formData.getAll('targetLanguages').map(String).filter(Boolean)
  const targetOperatingSystems = formData
    .getAll('targetOperatingSystems')
    .map(String)
    .filter(Boolean)
  const targetBrowsers = formData.getAll('targetBrowsers').map(String).filter(Boolean)

  /**
   * Server-side re-validation of the wizard's own rules. The steps block
   * progress on these, but a disabled Next button is not validation — a
   * hand-built POST has to hit the same wall.
   */
  const maxTesters = maxTestersRaw ? Number(maxTestersRaw) : NaN
  if (!title || title.length < 3) redirect(`${WIZARD}?step=general&error=title`)
  if (!buildName) redirect(`${WIZARD}?step=general&error=build`)
  if (!appUrl || !/^https?:\/\//i.test(appUrl)) redirect(`${WIZARD}?step=general&error=url`)
  if (!Number.isInteger(maxTesters) || maxTesters < 1) {
    redirect(`${WIZARD}?step=general&error=participants`)
  }
  if (!startDate || !endDate) redirect(`${WIZARD}?step=general&error=dates`)
  if (endDate < startDate) redirect(`${WIZARD}?step=general&error=range`)
  if (!instructions) redirect(`${WIZARD}?step=details&error=instructions`)

  let project: CreatedProject
  try {
    project = await actionFetch<CreatedProject>('projects', {
      method: 'POST',
      body: {
        title,
        // The wizard's "describe the testing" doubles as the project brief so
        // the project reads sensibly on its own, not only through the build.
        summary: instructions.slice(0, 2000),
        instructions,
        platformTargets,
        targetCountries,
        targetLanguages,
        maxTesters,
        startDate,
        endDate,
        ...(logoFileId ? { logoFileId } : {}),
      },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    redirect(`${WIZARD}?step=general&error=${status === 422 ? 'invalid' : 'failed'}`)
  }

  /**
   * Find the default build the create just made. A failure here is not worth
   * losing the project over — fall through to the project page and say the
   * build still needs its details.
   */
  let buildId: string | null = null
  try {
    const detail = await actionFetch<CreatedProject>(`projects/${project.id}`)
    buildId = detail.builds?.find((b) => b.isDefault)?.id ?? detail.builds?.[0]?.id ?? null
  } catch {
    buildId = null
  }

  if (buildId) {
    try {
      await actionFetch(`projects/${project.id}/builds/${buildId}`, {
        method: 'PATCH',
        body: {
          name: buildName,
          appUrl,
          instructions,
          maxTesters,
          startDate,
          endDate,
          targetCountries,
          targetLanguages,
          ...(testType ? { testType } : {}),
          ...(specialRequirements ? { specialRequirements } : {}),
          ...(testDocumentFileId ? { testDocumentFileId } : {}),
          ...(targetOperatingSystems.length ? { targetOperatingSystems } : {}),
          ...(targetBrowsers.length ? { targetBrowsers } : {}),
        },
      })
    } catch {
      revalidatePath('/app/customer/projects')
      redirect(`/app/customer/projects/${project.id}?notice=build-incomplete`)
    }
  }

  revalidatePath('/app/customer/projects')
  revalidatePath('/app/customer')
  redirect(`/app/customer/projects/${project.id}?notice=created`)
}

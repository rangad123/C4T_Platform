'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

const WIZARD = '/app/customer/projects/new'

/**
 * Rebuilds the wizard's own query string from what was submitted, so a
 * rejected create returns the person to a filled-in form rather than an
 * empty one.
 *
 * `logoFileId` is deliberately dropped when the logo itself was the problem:
 * sending back a reference that just failed would fail again on the next
 * submit, with the same opaque result.
 */
function carryBack(formData: FormData, errorCode: string): string {
  const keep = [
    'subject',
    'title',
    'buildName',
    'appUrl',
    'logoFileId',
    'logoFileName',
    'maxTesters',
    'startDate',
    'endDate',
    'testType',
    'testDocumentFileId',
    'testDocumentFileName',
    'instructions',
    'specialRequirements',
  ] as const

  const params = new URLSearchParams()
  for (const key of keep) {
    // The name travels with the id, so a cleared logo does not leave its
    // filename behind claiming a file that is no longer attached.
    if (errorCode === 'logo' && (key === 'logoFileId' || key === 'logoFileName')) continue
    const value = formTrimmed(formData, key)
    if (value) params.set(key, value)
  }
  for (const key of ['platformTargets', 'targetCountries', 'targetLanguages'] as const) {
    for (const value of formData.getAll(key).map(String).filter(Boolean)) {
      params.append(key, value)
    }
  }
  params.set('step', 'general')
  params.set('error', errorCode)
  return params.toString()
}

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
  /**
   * A URL is checked for shape, not for presence.
   *
   * Requiring one was a wizard-only rule that the API never had: `appUrl` is
   * optional on a build and only format-checked when supplied. It blocked
   * real cases the platform otherwise supports — a mobile build distributed
   * as an APK, or a project scoped before a staging URL exists — for no
   * reason the backend agreed with. Anything actually typed still has to be
   * a URL, so a typo is caught rather than saved.
   */
  if (appUrl && !/^https?:\/\//i.test(appUrl)) redirect(`${WIZARD}?step=general&error=url`)
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
    /**
     * Say which thing went wrong when the API was specific about it.
     *
     * Everything except a 422 used to collapse into "could not be created,
     * try again in a moment" — advice that is actively wrong for the most
     * likely causes. A customer with no organisation, or one who belongs to
     * several, gets a precise 403/400 from `resolveOrganisationId`, and
     * retrying in a moment will never fix either.
     */
    const status = error instanceof ApiError ? error.status : 0
    const message = error instanceof ApiError ? error.message.toLowerCase() : ''
    let code = 'failed'
    if (status === 422) code = 'invalid'
    else if (status === 403 && message.includes('organisation')) code = 'no-org'
    else if (status === 400 && message.includes('several organisations')) code = 'many-orgs'
    else if (status === 400 && message.includes('logo')) code = 'logo'
    else if (status === 409) code = 'duplicate'
    /**
     * Everything typed goes back with the error.
     *
     * A rejected create used to return a bare `?error=`, so the wizard came
     * back blank and four steps of input were gone — punishing the person for
     * a failure that was usually not theirs. The fields are already carried
     * between steps in the query string; carrying them through a failure too
     * is the same mechanism.
     */
    redirect(`${WIZARD}?${carryBack(formData, code)}`)
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
          // `null`, not `''`. The field is nullable but format-checked, so an
          // empty string is not "no URL" to the API — it is a malformed one,
          // and it fails the whole build update. That surfaced as "the
          // project was created, but its first build still needs its details"
          // for every project deliberately created without a URL.
          appUrl: appUrl || null,
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

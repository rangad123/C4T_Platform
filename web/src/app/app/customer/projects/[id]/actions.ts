'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { formTrimmed, formList } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'
import { isProjectPriority, isProjectStatus } from './constants'

/**
 * Server Actions for the customer's own project detail page.
 *
 * Subset of `admin/projects/[id]/actions.ts` — drops `inviteTesters`,
 * `updateAssignment`, `createTestCase`, `assignTestCase` (no Testers/Test
 * reports tab here) and `archiveProject` (customer has no `project.delete`
 * relation). Everything kept is otherwise identical: the API is the
 * enforcement point either way.
 */

function revalidateProject(id: string): void {
  revalidatePath('/app/customer/projects')
  revalidatePath(`/app/customer/projects/${id}`)
}

export async function updateProjectBrief(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const title = formTrimmed(formData, 'title')
  const body: Record<string, unknown> = {
    summary: formTrimmed(formData, 'summary'),
    instructions: formTrimmed(formData, 'instructions'),
    platformTargets: formList(formData, 'platformTargets'),
    targetCountries: formList(formData, 'targetCountries').map((code) => code.toUpperCase()),
    targetLanguages: formList(formData, 'targetLanguages').map((code) => code.toLowerCase()),
    startDate: formTrimmed(formData, 'startDate') || null,
    endDate: formTrimmed(formData, 'endDate') || null,
  }
  if (title.length >= 3) body.title = title

  const maxTesters = formTrimmed(formData, 'maxTesters')
  body.maxTesters = maxTesters ? maxTesters : null
  body.testersCanSeeOtherBugs = formData.has('testersCanSeeOtherBugs')

  try {
    await actionFetch(`projects/${id}`, { method: 'PATCH', body })
  } catch {
    redirect(`/app/customer/projects/${id}?notice=brief-save-failed`, 'replace')
  }

  revalidateProject(id)
  redirect(`/app/customer/projects/${id}?notice=brief-saved`, 'replace')
}

export async function updateProjectDelivery(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const body: Record<string, unknown> = {}
  const priority = formTrimmed(formData, 'priority')
  if (isProjectPriority(priority)) body.priority = priority

  const progress = Number.parseInt(formTrimmed(formData, 'progressPercent'), 10)
  if (Number.isFinite(progress)) {
    body.progressPercent = Math.max(0, Math.min(100, progress))
  }
  if (Object.keys(body).length === 0) return

  let notice = 'delivery-saved'
  try {
    await actionFetch(`projects/${id}`, { method: 'PATCH', body })
  } catch (error) {
    notice = noticeFor(error, 'delivery')
  }

  revalidateProject(id)
  redirect(`/app/customer/projects/${id}?notice=${notice}`, 'replace')
}

/**
 * Move the project through its lifecycle.
 *
 * The picker offers only `DRAFT → SUBMITTED`, because that is the only move
 * the API grants a customer — see `STATUS_TRANSITIONS` in `./constants`. It
 * used to offer the whole structural matrix, so choosing "Cancelled" on a
 * draft returned 403 ("Only the delivery team can make that status change")
 * and, with no catch here, Next rendered its crash screen: "This page hit a
 * problem", reference number and all, for what was a perfectly good refusal.
 *
 * The catch stays even though the menu no longer offers the impossible: an
 * admin moving the project in another tab changes what is legal underneath
 * this form, and a stale tab must get a sentence, not a stack trace.
 */
export async function changeProjectStatus(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const status = formTrimmed(formData, 'status')
  if (!id || !isProjectStatus(status)) return

  const note = formTrimmed(formData, 'note')
  const buildId = formTrimmed(formData, 'buildId')

  let notice = 'status-changed'
  try {
    await actionFetch(`projects/${id}/status`, {
      method: 'POST',
      body: { status, ...(note ? { note } : {}) },
    })
  } catch (error) {
    const code = error instanceof ApiError ? error.status : 0
    // 403 is "not yours to make"; 409 is "no longer legal from here", which is
    // what a stale tab hits. Neither is a fault worth a crash screen.
    notice = code === 403 ? 'status-forbidden' : code === 409 ? 'status-stale' : 'status-failed'
  }

  revalidateProject(id)
  redirect(buildHref(id, buildId, notice, { section: 'build' }), 'replace')
}

/**
 * Attach a material to the build.
 *
 * Two things used to go wrong here, and they compounded.
 *
 * The form asked for a raw `fileId` — an internal cuid — so whatever a person
 * typed there failed the API's `z.string().cuid()` with a 422. And this action
 * had no try/catch, so that 422 escaped into Next's error boundary: clicking
 * "Attach material" produced "This page hit a problem" with a reference
 * number, which reads as the platform breaking rather than as a rejected
 * value. Same failure the build actions above already guard against.
 *
 * The file id now comes from `InlineFileUpload`, so it is always one the
 * uploads endpoint just minted. The catch stays regardless — an upload whose
 * file was swept, or a project archived in another tab, must still land as a
 * sentence rather than a crash.
 *
 * The two "nothing to do" cases used to `return` silently, which is its own
 * small bug: the button appeared to do nothing at all. They now say why.
 */
export async function addMaterial(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const title = formTrimmed(formData, 'title')
  if (!id) return

  const description = formTrimmed(formData, 'description')
  const url = formTrimmed(formData, 'url')
  const fileId = formTrimmed(formData, 'fileId')
  const buildId = formTrimmed(formData, 'buildId')

  if (!title)
    redirect(buildHref(id, buildId, 'material-title', { section: 'materials' }), 'replace')
  if (!url && !fileId)
    redirect(buildHref(id, buildId, 'material-empty', { section: 'materials' }), 'replace')

  let notice = 'material-added'
  try {
    await actionFetch(`projects/${id}/materials`, {
      method: 'POST',
      body: {
        title,
        ...(description ? { description } : {}),
        ...(url ? { url } : {}),
        ...(fileId ? { fileId } : {}),
        ...(buildId ? { buildId } : {}),
      },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    notice = status === 422 || status === 400 ? 'material-invalid' : 'material-failed'
  }

  revalidateProject(id)
  redirect(buildHref(id, buildId, notice, { section: 'materials' }), 'replace')
}

export async function removeMaterial(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const materialId = formTrimmed(formData, 'materialId')
  if (!id || !materialId) return

  let notice = 'material-removed'
  try {
    await actionFetch(`projects/${id}/materials/${materialId}`, { method: 'DELETE' })
  } catch (error) {
    notice = noticeFor(error, 'material')
  }

  revalidateProject(id)
  redirect(`/app/customer/projects/${id}?section=materials&notice=${notice}`, 'replace')
}

export async function addFeature(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const buildId = formTrimmed(formData, 'buildId')

  let notice = 'feature-added'
  try {
    await actionFetch(`projects/${id}/features`, {
      method: 'POST',
      body: { name, ...(buildId ? { buildId } : {}) },
    })
  } catch (error) {
    notice = noticeFor(error, 'feature')
  }

  revalidateProject(id)
  redirect(buildHref(id, buildId, notice, { section: 'settings' }), 'replace')
}

export async function removeFeature(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const featureId = formTrimmed(formData, 'featureId')
  if (!id || !featureId) return

  let notice = 'feature-removed'
  try {
    await actionFetch(`projects/${id}/features/${featureId}`, { method: 'DELETE' })
  } catch (error) {
    notice = noticeFor(error, 'feature')
  }

  revalidateProject(id)
  redirect(`/app/customer/projects/${id}?section=settings&notice=${notice}`, 'replace')
}

// ─── Builds ────────────────────────────────────────────────────────────────

export async function createBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const section = formTrimmed(formData, 'section') || 'build'
  const maxTesters = formTrimmed(formData, 'maxTesters')

  // One request. This used to POST the name and then PATCH everything else,
  // so a failure on the second call left a nameless-but-real build behind
  // while the browser had already navigated away from the form.
  let build: { id: string }
  try {
    build = await actionFetch<{ id: string }>(`projects/${id}/builds`, {
      method: 'POST',
      body: {
        name,
        status: formTrimmed(formData, 'status'),
        testType: formTrimmed(formData, 'testType') || null,
        description: formTrimmed(formData, 'description') || null,
        appUrl: formTrimmed(formData, 'appUrl') || null,
        releaseNotes: formTrimmed(formData, 'releaseNotes') || null,
        instructions: formTrimmed(formData, 'instructions') || null,
        specialRequirements: formTrimmed(formData, 'specialRequirements') || null,
        targetDevices: formList(formData, 'targetDevices'),
        targetBrowsers: formList(formData, 'targetBrowsers'),
        targetOperatingSystems: formList(formData, 'targetOperatingSystems'),
        targetCountries: formList(formData, 'targetCountries').map((c) => c.toUpperCase()),
        targetLanguages: formList(formData, 'targetLanguages').map((l) => l.toLowerCase()),
        startDate: formTrimmed(formData, 'startDate') || null,
        endDate: formTrimmed(formData, 'endDate') || null,
        maxTesters: maxTesters ? maxTesters : null,
        testersCanSeeOtherBugs: formData.has('testersCanSeeOtherBugs'),
      },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    const notice = status === 409 ? 'build-name-taken' : 'build-create-failed'
    const params = new URLSearchParams({ section, notice })
    if (status === 409) params.set('edit', 'new-build')
    redirect(`/app/customer/projects/${id}?${params.toString()}`, 'replace')
  }

  revalidateProject(id)
  redirect(buildHref(id, build.id, 'build-created', { section }), 'replace')
}

/**
 * Renaming, saving and creating a build all have to END IN A REDIRECT.
 *
 * `Modal` derives its open state from `searchParams.edit`, so the only thing
 * that closes it is navigating to a URL without that parameter. These actions
 * used to update the build and simply return: the PATCH succeeded, the data
 * behind the dialog refreshed, and the dialog stayed open with no
 * confirmation — indistinguishable from a save button that does nothing,
 * which is exactly how it was reported.
 *
 * The failure path matters as much. Without a catch, an `ApiError` from a
 * duplicate name escapes the action and Next renders the segment's crash
 * screen over the whole page, losing what the user typed. Mapping it to a
 * notice keeps them on the page with a sentence about the actual problem.
 */
/**
 * One mapping from an API refusal to a notice code, shared by the actions on
 * this page that have no more specific story than "that did not work".
 * Resolved to a sentence by `NOTICES` on the project page.
 */
function noticeFor(error: unknown, prefix: string): string {
  const code = error instanceof ApiError ? error.status : 0
  if (code === 404) return `${prefix}-missing`
  if (code === 403) return `${prefix}-forbidden`
  if (code === 409) return `${prefix}-conflict`
  if (code === 400 || code === 422) return `${prefix}-invalid`
  return `${prefix}-failed`
}

function buildHref(
  id: string,
  buildId: string,
  notice: string,
  extra?: { section?: string; edit?: string; name?: string },
): string {
  const params = new URLSearchParams({ buildId, notice })
  if (extra?.section) params.set('section', extra.section)
  if (extra?.edit) params.set('edit', extra.edit)
  // Echoed so a reopened dialog shows what was typed, not the stored value.
  if (extra?.name) params.set('name', extra.name)
  return `/app/customer/projects/${id}?${params.toString()}`
}

export async function renameBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  const name = formTrimmed(formData, 'name')
  const section = formTrimmed(formData, 'section') || 'build'
  if (!id || !buildId || !name) return

  try {
    await actionFetch(`projects/${id}/builds/${buildId}`, { method: 'PATCH', body: { name } })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    // 409 is the API's own uniqueness check: build names are unique per
    // project. Keep the dialog open for it so the name can be corrected
    // without retyping anything else.
    if (status === 409) {
      redirect(
        buildHref(id, buildId, 'build-name-taken', { section, edit: 'rename-build', name }),
        'replace',
      )
    }
    redirect(buildHref(id, buildId, 'build-rename-failed', { section }), 'replace')
  }

  revalidateProject(id)
  redirect(buildHref(id, buildId, 'build-renamed', { section }), 'replace')
}

export async function updateBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !buildId) return

  const name = formTrimmed(formData, 'name')
  const body: Record<string, unknown> = {
    status: formTrimmed(formData, 'status'),
    testType: formTrimmed(formData, 'testType') || null,
    description: formTrimmed(formData, 'description') || null,
    appUrl: formTrimmed(formData, 'appUrl') || null,
    releaseNotes: formTrimmed(formData, 'releaseNotes') || null,
    instructions: formTrimmed(formData, 'instructions') || null,
    specialRequirements: formTrimmed(formData, 'specialRequirements') || null,
    targetDevices: formList(formData, 'targetDevices'),
    targetBrowsers: formList(formData, 'targetBrowsers'),
    targetOperatingSystems: formList(formData, 'targetOperatingSystems'),
    targetCountries: formList(formData, 'targetCountries').map((c) => c.toUpperCase()),
    targetLanguages: formList(formData, 'targetLanguages').map((l) => l.toLowerCase()),
    startDate: formTrimmed(formData, 'startDate') || null,
    endDate: formTrimmed(formData, 'endDate') || null,
    testersCanSeeOtherBugs: formData.has('testersCanSeeOtherBugs'),
  }
  if (name) body.name = name
  const maxTesters = formTrimmed(formData, 'maxTesters')
  body.maxTesters = maxTesters ? maxTesters : null

  const section = formTrimmed(formData, 'section') || 'build'

  try {
    await actionFetch(`projects/${id}/builds/${buildId}`, { method: 'PATCH', body })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    if (status === 409) {
      redirect(
        buildHref(id, buildId, 'build-name-taken', { section, edit: 'build-details' }),
        'replace',
      )
    }
    redirect(buildHref(id, buildId, 'build-save-failed', { section }), 'replace')
  }

  revalidateProject(id)
  redirect(buildHref(id, buildId, 'build-saved', { section }), 'replace')
}

// ─── Custom bug fields (§36-38) ──────────────────────────────────────────────

/**
 * Turns the build's extra bug questions on or off.
 *
 * Separate from adding fields: switching it off hides them from the tester
 * form without deleting the definitions, so a client can pause the extra
 * questions without losing what they configured or what testers already
 * answered.
 */
export async function setBugCustomization(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !buildId) return

  try {
    await actionFetch(`projects/${id}/builds/${buildId}`, {
      method: 'PATCH',
      body: { bugCustomizationEnabled: formTrimmed(formData, 'enabled') === 'yes' },
    })
  } catch {
    redirect(buildHref(id, buildId, 'settings-save-failed', { section: 'settings' }), 'replace')
  }

  revalidateProject(id)
  redirect(buildHref(id, buildId, 'settings-saved', { section: 'settings' }), 'replace')
}

export async function addBugCustomField(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  const name = formTrimmed(formData, 'name')
  const type = formTrimmed(formData, 'type')
  if (!id || !buildId || !name || !type) return

  /**
   * Options arrive as repeated `option` inputs, one per row the user added.
   * Blank rows are dropped here so an empty extra row does not become an
   * empty choice — the API would reject the whole field for it.
   */
  const options = formData
    .getAll('option')
    .map(String)
    .map((o) => o.trim())
    .filter(Boolean)

  const section = formTrimmed(formData, 'section') || 'settings'

  try {
    await actionFetch(`projects/${id}/custom-fields`, {
      method: 'POST',
      body: {
        buildId,
        name,
        type,
        isRequired: formData.has('isRequired'),
        ...(options.length > 0 ? { options } : {}),
      },
    })
  } catch (error) {
    /**
     * The API's rules are the real ones — a duplicate name, a choice type
     * with no options, repeated options. Each maps to a code the page turns
     * into a sentence rather than forwarding the API's own wording.
     */
    const status = error instanceof ApiError ? error.status : 0
    const code = status === 409 ? 'field-exists' : status === 400 ? 'field-invalid' : 'field-failed'
    redirect(
      `/app/customer/projects/${id}?section=${section}&buildId=${buildId}&notice=${code}`,
      'replace',
    )
  }

  revalidateProject(id)
  redirect(
    `/app/customer/projects/${id}?section=${section}&buildId=${buildId}&notice=field-added`,
    'replace',
  )
}

export async function removeBugCustomField(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const fieldId = formTrimmed(formData, 'fieldId')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !fieldId) return

  let notice = 'field-removed'
  try {
    await actionFetch(`projects/${id}/custom-fields/${fieldId}`, { method: 'DELETE' })
  } catch (error) {
    notice = noticeFor(error, 'field')
  }

  revalidateProject(id)
  redirect(
    `/app/customer/projects/${id}?section=settings${buildId ? `&buildId=${buildId}` : ''}&notice=${notice}`,
    'replace',
  )
}

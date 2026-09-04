'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { formString, formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'
import { isAssignmentStatus, isProjectPriority, isProjectStatus } from './constants'

/**
 * Server Actions for the project detail page (§2.2 Project Management).
 *
 * EVERY export here is an async function. A type, const or class exported from a
 * `'use server'` module unregisters every action in the file and the forms fail
 * at runtime with an opaque UnrecognizedActionError — the enums and shapes these
 * actions validate against therefore live in `./constants.ts`.
 *
 * The API is the enforcement point: it owns the audit log, the ReBAC check, the
 * permission gate and the lifecycle graph. These actions only shape the form
 * body and then revalidate the list and the detail page so the next render sees
 * the write. Enum membership is checked before the call purely so a hand-posted
 * body fails here rather than costing a round trip.
 */

/** Both pages that can show a stale project after a write. */
function revalidateProject(id: string): void {
  revalidatePath('/app/admin/projects')
  revalidatePath(`/app/admin/projects/${id}`)
}

/**
 * Where a modal action lands when it finishes.
 *
 * `Modal` is driven by the URL: it is open while `?edit=` names it, so the
 * ONLY way to close one is a redirect that drops that parameter. An action
 * that saves and then just falls off the end leaves the dialog sitting there
 * looking like the click did nothing — which is exactly how a working save
 * came to be reported as a broken one.
 *
 * Passing `edit` back instead reopens the dialog, which is what a failure
 * wants: the values stay on screen to be corrected.
 */
function projectHref(
  id: string,
  extra?: {
    section?: string
    buildId?: string
    edit?: string
    error?: string
    name?: string
    notice?: string
    detail?: string
  },
): string {
  const params = new URLSearchParams()
  if (extra?.section) params.set('section', extra.section)
  if (extra?.buildId) params.set('buildId', extra.buildId)
  if (extra?.edit) params.set('edit', extra.edit)
  if (extra?.error) params.set('error', extra.error)
  if (extra?.notice) params.set('notice', extra.notice)
  // The API's own sentence, when it wrote one a reader can act on.
  if (extra?.detail) params.set('detail', extra.detail)
  // Echoed so a reopened dialog shows what was typed, not the stored value.
  if (extra?.name) params.set('name', extra.name)
  const qs = params.toString()
  return qs ? `/app/admin/projects/${id}?${qs}` : `/app/admin/projects/${id}`
}

/** `Android, iOS , web` → `['Android', 'iOS', 'web']`. */
function parseList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * The project brief — everything in `updateProjectSchema` except priority and
 * progress, which belong to the delivery panel in the aside.
 *
 * `summary` and `instructions` are sent even when blank: the schema accepts an
 * empty string, so submitting one is how an admin clears a field. `startDate`
 * and `endDate` are nullable there, so a cleared date input sends null.
 */
export async function updateProjectBrief(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const title = formTrimmed(formData, 'title')
  const body: Record<string, unknown> = {
    summary: formTrimmed(formData, 'summary'),
    instructions: formTrimmed(formData, 'instructions'),
    platformTargets: parseList(formString(formData, 'platformTargets')),
    targetCountries: parseList(formString(formData, 'targetCountries')).map((code) =>
      code.toUpperCase(),
    ),
    targetLanguages: parseList(formString(formData, 'targetLanguages')).map((code) =>
      code.toLowerCase(),
    ),
    startDate: formTrimmed(formData, 'startDate') || null,
    endDate: formTrimmed(formData, 'endDate') || null,
  }
  // The schema floors the title at 3 characters. Omitting a blank one leaves the
  // stored title alone instead of failing the whole save on one empty field.
  if (title.length >= 3) body.title = title

  const maxTesters = formTrimmed(formData, 'maxTesters')
  body.maxTesters = maxTesters ? maxTesters : null

  // A checkbox's FormData entry is present only when checked — there is no
  // "false" value to read, so absence IS the off state.
  body.testersCanSeeOtherBugs = formData.has('testersCanSeeOtherBugs')

  const section = formTrimmed(formData, 'section')
  const buildId = formTrimmed(formData, 'buildId')
  try {
    await actionFetch(`projects/${id}`, { method: 'PATCH', body })
  } catch {
    redirect(projectHref(id, { section, buildId, edit: 'brief', error: 'brief-save-failed' }))
  }

  revalidateProject(id)
  redirect(projectHref(id, { section, buildId }))
}

/** Priority and reported progress. One PATCH, one panel. */
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

  const section = formTrimmed(formData, 'section')
  const buildId = formTrimmed(formData, 'buildId')
  try {
    await actionFetch(`projects/${id}`, { method: 'PATCH', body })
  } catch {
    redirect(projectHref(id, { section, buildId, edit: 'brief', error: 'brief-save-failed' }))
  }

  revalidateProject(id)
  redirect(projectHref(id, { section, buildId }))
}

/**
 * One mapping from an API refusal to a notice code, for every action on this
 * page that has no more specific story to tell.
 *
 * `prefix` names the thing being acted on, so the reader is told what failed
 * rather than that "something" did. The codes are resolved to sentences by
 * `PAGE_NOTICES` on the project page.
 */
function noticeFor(error: unknown, prefix: string): string {
  const code = error instanceof ApiError ? error.status : 0
  if (code === 404) return `${prefix}-missing`
  if (code === 403) return `${prefix}-forbidden`
  if (code === 409) return `${prefix}-conflict`
  if (code === 400 || code === 422) return `${prefix}-invalid`
  return `${prefix}-failed`
}

/**
 * A lifecycle move.
 *
 * The select only offers destinations the API accepts, so a refusal here is
 * not the reader's mistake — it is a transition that became illegal while
 * they had the page open, most often because someone else moved the project
 * first. Unguarded, that answered with Next's crash screen; the twin of this
 * action in the customer portal was fixed and this one was not.
 */
export async function changeProjectStatus(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const status = formTrimmed(formData, 'status')
  if (!id || !isProjectStatus(status)) return

  const note = formTrimmed(formData, 'note')

  let notice = 'status-changed'
  try {
    await actionFetch(`projects/${id}/status`, {
      method: 'POST',
      body: { status, ...(note ? { note } : {}) },
    })
  } catch (error) {
    const code = error instanceof ApiError ? error.status : 0
    notice =
      code === 409 || code === 400
        ? 'status-illegal'
        : code === 403
          ? 'status-forbidden'
          : 'status-failed'
  }

  revalidateProject(id)
  redirect(projectHref(id, { notice }))
}

/**
 * Invite one or more verified testers.
 *
 * The roster is a checkbox list, so `getAll` is what reads it — `formString`
 * would take only the first tick and quietly drop the rest of the batch. The API
 * validates every tester before writing any of them, so a partial batch never
 * half-applies.
 */
export async function inviteTesters(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const testerIds = formData
    .getAll('testerIds')
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (testerIds.length === 0) return

  const notes = formTrimmed(formData, 'notes')
  const buildId = formTrimmed(formData, 'buildId')

  try {
    await actionFetch(`projects/${id}/assignments`, {
      method: 'POST',
      body: { testerIds, ...(notes ? { notes } : {}), ...(buildId ? { buildId } : {}) },
    })
  } catch (error) {
    /**
     * The API writes these 4xx messages for people — "Testers cannot be added
     * to a paused, completed or cancelled project" says exactly what to do
     * about it. Throwing sent that to the page's crash screen instead, which
     * replaced a sentence the reader could act on with a reference number
     * they could not.
     *
     * Only 4xx text is passed through. A 5xx describes our internals.
     */
    const status = error instanceof ApiError ? error.status : 0
    const detail =
      status >= 400 && status < 500 && error instanceof ApiError ? error.message.slice(0, 200) : ''
    redirect(
      projectHref(id, {
        section: 'testers',
        buildId,
        notice: 'invite-failed',
        detail,
      }),
    )
  }

  revalidateProject(id)
  redirect(projectHref(id, { section: 'testers', buildId, notice: 'invited' }))
}

/** Activate, complete or remove one tester on the roster. */
/**
 * Move one tester's standing on this build — activate them, mark them done,
 * or take them off it.
 *
 * REMOVING IS A STATUS CHANGE, NOT A DELETE. The API sets `status: REMOVED`
 * and stamps `removedAt`, keeping the row: the bug reports, payments and work
 * history that point at this assignment all depend on it still existing. The
 * seat is freed (the `maxTesters` count skips REMOVED and DECLINED), but the
 * record stays.
 *
 * The catch is not decoration. Like `addMaterial` and `changeProjectStatus`
 * in this same file, this action posted straight through, so a 404 from a
 * roster the reader had open while someone else changed it came back as
 * Next's crash screen instead of a sentence.
 */
export async function updateAssignment(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const testerId = formTrimmed(formData, 'testerId')
  const status = formTrimmed(formData, 'status')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !testerId || !buildId || !isAssignmentStatus(status)) return

  const notes = formTrimmed(formData, 'notes')

  let notice = status === 'REMOVED' ? 'assignment-removed' : 'assignment-updated'
  try {
    await actionFetch(`projects/${id}/assignments/${testerId}`, {
      method: 'PATCH',
      body: { buildId, status, ...(notes ? { notes } : {}) },
    })
  } catch (error) {
    const code = error instanceof ApiError ? error.status : 0
    notice =
      code === 404
        ? 'assignment-missing'
        : code === 403
          ? 'assignment-forbidden'
          : 'assignment-failed'
  }

  revalidateProject(id)
  redirect(projectHref(id, { section: 'testers', buildId, notice }))
}

/**
 * Attach a material. `addMaterialSchema` demands a title plus either a `fileId`
 * from the uploads module or a URL, so a submission with neither is dropped here
 * rather than sent to be refused.
 */
export async function addMaterial(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const title = formTrimmed(formData, 'title')
  if (!id || !title) return

  const description = formTrimmed(formData, 'description')
  const url = formTrimmed(formData, 'url')
  const fileId = formTrimmed(formData, 'fileId')
  const buildId = formTrimmed(formData, 'buildId')
  if (!url && !fileId) return

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
    const code = error instanceof ApiError ? error.status : 0
    notice = code === 422 || code === 400 ? 'material-invalid' : 'material-failed'
  }

  revalidateProject(id)
  redirect(projectHref(id, { section: 'materials', buildId, notice }))
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
  redirect(projectHref(id, { section: 'materials', notice }))
}

/** §2.2 Build Settings "Feature Lists" — the tags a bug can be filed against. */
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
  redirect(projectHref(id, { section: 'build', buildId, notice }))
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
  redirect(projectHref(id, { section: 'build', notice }))
}

/**
 * Archive the project. The API soft-deletes it and sets the status to cancelled.
 *
 * The typed confirmation is a UX guard, not a security control — the API's
 * `project.delete` gate is the real one. It exists because the button sits on a
 * page with eight other submits and there is no client JavaScript here to raise
 * a dialog.
 */
export async function archiveProject(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const reference = formTrimmed(formData, 'reference')
  const confirmation = formTrimmed(formData, 'confirm')
  if (!id || !reference) return
  if (confirmation.toUpperCase() !== reference.toUpperCase()) return

  /*
    On failure the reader stays on the project with a reason, rather than
    being sent to the list as though the archive had worked.
  */
  let failed: string | null = null
  try {
    await actionFetch(`projects/${id}`, { method: 'DELETE' })
  } catch (error) {
    failed = noticeFor(error, 'archive')
  }

  revalidateProject(id)
  // `redirect` throws to unwind — it must be the last statement and must not sit
  // inside a try/catch.
  if (failed) redirect(projectHref(id, { section: 'settings', notice: failed }))
  redirect('/app/admin/projects')
}

// ─── Builds ────────────────────────────────────────────────────────────────

/**
 * A new build is also a navigation: the reader almost always wants to land
 * looking at what they just created, not stay on whichever build they were
 * viewing before. `section` rides along as a hidden field so switching
 * builds does not also bounce back to the Overview tab.
 *
 * The API's create endpoint only ever accepts a name — every other field is
 * an immediate follow-up PATCH, the same body `updateBuild` below sends.
 * That second call is what actually lands the "copy general details from
 * the original build" behaviour: the modal's fields arrive pre-filled from
 * the project's default build (the page computes that, not this action),
 * so whatever the admin leaves as-is or edits is what gets written here.
 */
export async function createBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const section = formTrimmed(formData, 'section')

  /*
    Two calls, and they fail differently.

    The create is fatal: with no build there is nothing to configure and
    nowhere to send the reader, so a refusal (a duplicate name, most often)
    reopens the modal with the reason and the typed name still in it.
  */
  let build: { id: string }
  try {
    build = await actionFetch<{ id: string }>(`projects/${id}/builds`, {
      method: 'POST',
      body: { name },
    })
  } catch (error) {
    const code = error instanceof ApiError ? error.status : 0
    redirect(
      projectHref(id, {
        section: section || 'build',
        edit: 'new-build',
        name,
        error: code === 409 ? 'build-name-taken' : 'build-create-failed',
      }),
    )
  }

  /*
    The follow-up PATCH is not fatal. The build exists either way, and losing
    it over one unsaved field would be the worse outcome — so the reader is
    taken to the new build and told the details did not stick, exactly as the
    project-create flow handles its own optional second call.
  */
  const maxTesters = formTrimmed(formData, 'maxTesters')
  let detailsSaved = true
  try {
    await actionFetch(`projects/${id}/builds/${build.id}`, {
      method: 'PATCH',
      body: {
        status: formTrimmed(formData, 'status'),
        testType: formTrimmed(formData, 'testType') || null,
        description: formTrimmed(formData, 'description') || null,
        appUrl: formTrimmed(formData, 'appUrl') || null,
        releaseNotes: formTrimmed(formData, 'releaseNotes') || null,
        instructions: formTrimmed(formData, 'instructions') || null,
        specialRequirements: formTrimmed(formData, 'specialRequirements') || null,
        targetDevices: parseList(formString(formData, 'targetDevices')),
        targetBrowsers: parseList(formString(formData, 'targetBrowsers')),
        targetOperatingSystems: parseList(formString(formData, 'targetOperatingSystems')),
        targetCountries: parseList(formString(formData, 'targetCountries')).map((c) =>
          c.toUpperCase(),
        ),
        targetLanguages: parseList(formString(formData, 'targetLanguages')).map((l) =>
          l.toLowerCase(),
        ),
        startDate: formTrimmed(formData, 'startDate') || null,
        endDate: formTrimmed(formData, 'endDate') || null,
        maxTesters: maxTesters ? maxTesters : null,
        testersCanSeeOtherBugs: formData.has('testersCanSeeOtherBugs'),
      },
    })
  } catch {
    detailsSaved = false
  }

  revalidateProject(id)

  const params = new URLSearchParams({ buildId: build.id })
  if (section) params.set('section', section)
  if (!detailsSaved) params.set('notice', 'build-details-unsaved')
  redirect(`/app/admin/projects/${id}?${params.toString()}`)
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
    /**
     * 409 is the API's own uniqueness check — build names are unique per
     * project, and a duplicate is far and away the likeliest way a rename
     * fails. Reopen the dialog with the typed name still in it rather than
     * throwing to the page's crash screen, which loses the input and says
     * nothing about what went wrong.
     */
    const status = error instanceof ApiError ? error.status : 0
    redirect(
      projectHref(id, {
        section,
        buildId,
        edit: 'rename-build',
        error: status === 409 ? 'build-name-taken' : 'build-rename-failed',
        name,
      }),
    )
  }

  revalidateProject(id)
  redirect(projectHref(id, { section, buildId }))
}

/**
 * The full Build Details form — §6 of the platform UX brief. Every field is
 * optional at the API, so a blank input clears it (matching
 * `updateProjectBrief`'s convention) rather than being dropped from the body.
 */
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
    testDocumentFileId: formTrimmed(formData, 'testDocumentFileId') || null,
    releaseNotes: formTrimmed(formData, 'releaseNotes') || null,
    instructions: formTrimmed(formData, 'instructions') || null,
    specialRequirements: formTrimmed(formData, 'specialRequirements') || null,
    targetDevices: parseList(formString(formData, 'targetDevices')),
    targetBrowsers: parseList(formString(formData, 'targetBrowsers')),
    targetOperatingSystems: parseList(formString(formData, 'targetOperatingSystems')),
    targetCountries: parseList(formString(formData, 'targetCountries')).map((c) => c.toUpperCase()),
    targetLanguages: parseList(formString(formData, 'targetLanguages')).map((l) => l.toLowerCase()),
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
    redirect(
      projectHref(id, {
        section,
        buildId,
        edit: 'build-details',
        error: status === 409 ? 'build-name-taken' : 'build-save-failed',
      }),
    )
  }

  revalidateProject(id)
  redirect(projectHref(id, { section, buildId }))
}

// ─── Structured testing workflow ──────────────────────────────────────────

export async function createTestCase(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  const title = formTrimmed(formData, 'title')
  const description = formTrimmed(formData, 'description')
  const steps = formTrimmed(formData, 'steps')
  const expectedResult = formTrimmed(formData, 'expectedResult')
  if (!id || !buildId || !title || !description || !steps || !expectedResult) return

  const feature = formTrimmed(formData, 'feature')

  let notice = 'test-case-created'
  try {
    await actionFetch('test-cases', {
      method: 'POST',
      body: { buildId, title, description, steps, expectedResult, ...(feature ? { feature } : {}) },
    })
  } catch (error) {
    notice = noticeFor(error, 'test-case')
  }

  revalidateProject(id)
  redirect(projectHref(id, { section: 'test-cases', buildId, notice }))
}

export async function assignTestCase(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const testCaseId = formTrimmed(formData, 'testCaseId')
  const testerId = formTrimmed(formData, 'testerId')
  if (!id || !testCaseId || !testerId) return

  let notice = 'test-case-assigned'
  try {
    await actionFetch(`test-cases/${testCaseId}/assignments`, {
      method: 'POST',
      body: { testerIds: [testerId] },
    })
  } catch (error) {
    notice = noticeFor(error, 'test-case')
  }

  revalidateProject(id)
  redirect(projectHref(id, { section: 'test-cases', notice }))
}

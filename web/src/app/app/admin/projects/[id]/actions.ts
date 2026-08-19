'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { formString, formTrimmed } from '@/lib/form-data'
import {
  isAssignmentStatus,
  isProjectPriority,
  isProjectStatus,
} from './constants'

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

  await serverFetch(`projects/${id}`, { method: 'PATCH', body })
  revalidateProject(id)
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

  await serverFetch(`projects/${id}`, { method: 'PATCH', body })
  revalidateProject(id)
}

/**
 * A lifecycle move. The select on the page only offers legal destinations, so
 * this normally cannot 409 — the enum check is the backstop for a posted body.
 */
export async function changeProjectStatus(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const status = formTrimmed(formData, 'status')
  if (!id || !isProjectStatus(status)) return

  const note = formTrimmed(formData, 'note')
  await serverFetch(`projects/${id}/status`, {
    method: 'POST',
    body: { status, ...(note ? { note } : {}) },
  })
  revalidateProject(id)
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
  await serverFetch(`projects/${id}/assignments`, {
    method: 'POST',
    body: { testerIds, ...(notes ? { notes } : {}), ...(buildId ? { buildId } : {}) },
  })
  revalidateProject(id)
}

/** Activate, complete or remove one tester on the roster. */
export async function updateAssignment(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const testerId = formTrimmed(formData, 'testerId')
  const status = formTrimmed(formData, 'status')
  if (!id || !testerId || !isAssignmentStatus(status)) return

  const notes = formTrimmed(formData, 'notes')
  await serverFetch(`projects/${id}/assignments/${testerId}`, {
    method: 'PATCH',
    body: { status, ...(notes ? { notes } : {}) },
  })
  revalidateProject(id)
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

  await serverFetch(`projects/${id}/materials`, {
    method: 'POST',
    body: {
      title,
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      ...(fileId ? { fileId } : {}),
      ...(buildId ? { buildId } : {}),
    },
  })
  revalidateProject(id)
}

export async function removeMaterial(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const materialId = formTrimmed(formData, 'materialId')
  if (!id || !materialId) return

  await serverFetch(`projects/${id}/materials/${materialId}`, { method: 'DELETE' })
  revalidateProject(id)
}

/** §2.2 Build Settings "Feature Lists" — the tags a bug can be filed against. */
export async function addFeature(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const buildId = formTrimmed(formData, 'buildId')
  await serverFetch(`projects/${id}/features`, {
    method: 'POST',
    body: { name, ...(buildId ? { buildId } : {}) },
  })
  revalidateProject(id)
}

export async function removeFeature(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const featureId = formTrimmed(formData, 'featureId')
  if (!id || !featureId) return

  await serverFetch(`projects/${id}/features/${featureId}`, { method: 'DELETE' })
  revalidateProject(id)
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

  await serverFetch(`projects/${id}`, { method: 'DELETE' })
  revalidateProject(id)
  // `redirect` throws to unwind — it must be the last statement and must not sit
  // inside a try/catch.
  redirect('/app/admin/projects')
}

// ─── Builds ────────────────────────────────────────────────────────────────

/**
 * A new build is also a navigation: the reader almost always wants to land
 * looking at what they just created, not stay on whichever build they were
 * viewing before. `section` rides along as a hidden field so switching
 * builds does not also bounce back to the Overview tab.
 */
export async function createBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const section = formTrimmed(formData, 'section')

  const build = await serverFetch<{ id: string }>(`projects/${id}/builds`, {
    method: 'POST',
    body: { name },
  })
  revalidateProject(id)

  const params = new URLSearchParams({ buildId: build.id })
  if (section) params.set('section', section)
  redirect(`/app/admin/projects/${id}?${params.toString()}`)
}

export async function renameBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  const name = formTrimmed(formData, 'name')
  if (!id || !buildId || !name) return

  await serverFetch(`projects/${id}/builds/${buildId}`, { method: 'PATCH', body: { name } })
  revalidateProject(id)
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

  await serverFetch(`projects/${id}/builds/${buildId}`, { method: 'PATCH', body })
  revalidateProject(id)
}

/** §7 "Copy Build" — lands on the new copy, on the build-details tab. */
export async function copyBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !buildId) return

  const copy = await serverFetch<{ id: string }>(`projects/${id}/builds/${buildId}/copy`, {
    method: 'POST',
  })
  revalidateProject(id)
  redirect(`/app/admin/projects/${id}?section=build&buildId=${copy.id}`)
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
  await serverFetch('test-cases', {
    method: 'POST',
    body: { buildId, title, description, steps, expectedResult, ...(feature ? { feature } : {}) },
  })
  revalidateProject(id)
}

export async function assignTestCase(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const testCaseId = formTrimmed(formData, 'testCaseId')
  const testerId = formTrimmed(formData, 'testerId')
  if (!id || !testCaseId || !testerId) return

  await serverFetch(`test-cases/${testCaseId}/assignments`, {
    method: 'POST',
    body: { testerIds: [testerId] },
  })
  revalidateProject(id)
}

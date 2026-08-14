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
  await serverFetch(`projects/${id}/assignments`, {
    method: 'POST',
    body: { testerIds, ...(notes ? { notes } : {}) },
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
  if (!url && !fileId) return

  await serverFetch(`projects/${id}/materials`, {
    method: 'POST',
    body: {
      title,
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      ...(fileId ? { fileId } : {}),
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

'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { formString, formTrimmed } from '@/lib/form-data'
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

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export async function updateProjectBrief(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const title = formTrimmed(formData, 'title')
  const body: Record<string, unknown> = {
    summary: formTrimmed(formData, 'summary'),
    instructions: formTrimmed(formData, 'instructions'),
    platformTargets: parseList(formString(formData, 'platformTargets')),
    targetCountries: parseList(formString(formData, 'targetCountries')).map((code) => code.toUpperCase()),
    targetLanguages: parseList(formString(formData, 'targetLanguages')).map((code) => code.toLowerCase()),
    startDate: formTrimmed(formData, 'startDate') || null,
    endDate: formTrimmed(formData, 'endDate') || null,
  }
  if (title.length >= 3) body.title = title

  const maxTesters = formTrimmed(formData, 'maxTesters')
  body.maxTesters = maxTesters ? maxTesters : null
  body.testersCanSeeOtherBugs = formData.has('testersCanSeeOtherBugs')

  await serverFetch(`projects/${id}`, { method: 'PATCH', body })
  revalidateProject(id)
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

  await serverFetch(`projects/${id}`, { method: 'PATCH', body })
  revalidateProject(id)
}

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

// ─── Builds ────────────────────────────────────────────────────────────────

export async function createBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const section = formTrimmed(formData, 'section')

  const build = await serverFetch<{ id: string }>(`projects/${id}/builds`, {
    method: 'POST',
    body: { name },
  })

  const maxTesters = formTrimmed(formData, 'maxTesters')
  await serverFetch(`projects/${id}/builds/${build.id}`, {
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
      targetCountries: parseList(formString(formData, 'targetCountries')).map((c) => c.toUpperCase()),
      targetLanguages: parseList(formString(formData, 'targetLanguages')).map((l) => l.toLowerCase()),
      startDate: formTrimmed(formData, 'startDate') || null,
      endDate: formTrimmed(formData, 'endDate') || null,
      maxTesters: maxTesters ? maxTesters : null,
      testersCanSeeOtherBugs: formData.has('testersCanSeeOtherBugs'),
    },
  })
  revalidateProject(id)

  const params = new URLSearchParams({ buildId: build.id })
  if (section) params.set('section', section)
  redirect(`/app/customer/projects/${id}?${params.toString()}`)
}

export async function renameBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  const name = formTrimmed(formData, 'name')
  if (!id || !buildId || !name) return

  await serverFetch(`projects/${id}/builds/${buildId}`, { method: 'PATCH', body: { name } })
  revalidateProject(id)
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

export async function copyBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !buildId) return

  const copy = await serverFetch<{ id: string }>(`projects/${id}/builds/${buildId}/copy`, {
    method: 'POST',
  })
  revalidateProject(id)
  redirect(`/app/customer/projects/${id}?section=build&buildId=${copy.id}`)
}

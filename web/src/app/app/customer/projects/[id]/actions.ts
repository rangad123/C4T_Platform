'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { formString, formTrimmed } from '@/lib/form-data'
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
    targetCountries: parseList(formString(formData, 'targetCountries')).map((code) =>
      code.toUpperCase(),
    ),
    targetLanguages: parseList(formString(formData, 'targetLanguages')).map((code) =>
      code.toLowerCase(),
    ),
    startDate: formTrimmed(formData, 'startDate') || null,
    endDate: formTrimmed(formData, 'endDate') || null,
  }
  if (title.length >= 3) body.title = title

  const maxTesters = formTrimmed(formData, 'maxTesters')
  body.maxTesters = maxTesters ? maxTesters : null
  body.testersCanSeeOtherBugs = formData.has('testersCanSeeOtherBugs')

  await actionFetch(`projects/${id}`, { method: 'PATCH', body })
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

  await actionFetch(`projects/${id}`, { method: 'PATCH', body })
  revalidateProject(id)
}

export async function changeProjectStatus(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const status = formTrimmed(formData, 'status')
  if (!id || !isProjectStatus(status)) return

  const note = formTrimmed(formData, 'note')
  await actionFetch(`projects/${id}/status`, {
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
  revalidateProject(id)
}

export async function removeMaterial(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const materialId = formTrimmed(formData, 'materialId')
  if (!id || !materialId) return

  await actionFetch(`projects/${id}/materials/${materialId}`, { method: 'DELETE' })
  revalidateProject(id)
}

export async function addFeature(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const buildId = formTrimmed(formData, 'buildId')
  await actionFetch(`projects/${id}/features`, {
    method: 'POST',
    body: { name, ...(buildId ? { buildId } : {}) },
  })
  revalidateProject(id)
}

export async function removeFeature(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const featureId = formTrimmed(formData, 'featureId')
  if (!id || !featureId) return

  await actionFetch(`projects/${id}/features/${featureId}`, { method: 'DELETE' })
  revalidateProject(id)
}

// ─── Builds ────────────────────────────────────────────────────────────────

export async function createBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const name = formTrimmed(formData, 'name')
  if (!id || !name) return

  const section = formTrimmed(formData, 'section')

  const build = await actionFetch<{ id: string }>(`projects/${id}/builds`, {
    method: 'POST',
    body: { name },
  })

  const maxTesters = formTrimmed(formData, 'maxTesters')
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

  await actionFetch(`projects/${id}/builds/${buildId}`, { method: 'PATCH', body: { name } })
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

  await actionFetch(`projects/${id}/builds/${buildId}`, { method: 'PATCH', body })
  revalidateProject(id)
}

export async function copyBuild(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !buildId) return

  const copy = await actionFetch<{ id: string }>(`projects/${id}/builds/${buildId}/copy`, {
    method: 'POST',
  })
  revalidateProject(id)
  redirect(`/app/customer/projects/${id}?section=build&buildId=${copy.id}`)
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

  await actionFetch(`projects/${id}/builds/${buildId}`, {
    method: 'PATCH',
    body: { bugCustomizationEnabled: formTrimmed(formData, 'enabled') === 'yes' },
  })
  revalidateProject(id)
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
    redirect(`/app/customer/projects/${id}?section=${section}&buildId=${buildId}&notice=${code}`)
  }

  revalidateProject(id)
  redirect(`/app/customer/projects/${id}?section=${section}&buildId=${buildId}&notice=field-added`)
}

export async function removeBugCustomField(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const fieldId = formTrimmed(formData, 'fieldId')
  const buildId = formTrimmed(formData, 'buildId')
  if (!id || !fieldId) return

  await actionFetch(`projects/${id}/custom-fields/${fieldId}`, { method: 'DELETE' })
  revalidateProject(id)
  redirect(
    `/app/customer/projects/${id}?section=settings${buildId ? `&buildId=${buildId}` : ''}&notice=field-removed`,
  )
}

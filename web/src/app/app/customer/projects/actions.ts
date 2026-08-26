'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { formString, formTrimmed } from '@/lib/form-data'
import { parseCommaList } from '@/lib/admin/csv'

interface ProjectResponse {
  id: string
}

/**
 * Create a project for the caller's own organisation.
 *
 * Unlike `lib/admin/project-actions.ts`'s `createProjectAction` (which lets
 * an admin pick any organisation), this never sends `organisationId` — the
 * API's `resolveOrganisationId` infers it from the caller's own membership
 * for a CUSTOMER request, which is the whole reason this page has no org
 * picker field.
 */
export async function createProjectAction(formData: FormData): Promise<void> {
  const startDate = formTrimmed(formData, 'startDate')
  const endDate = formTrimmed(formData, 'endDate')
  const maxTesters = formTrimmed(formData, 'maxTesters')

  const body = {
    title: formTrimmed(formData, 'title'),
    summary: formTrimmed(formData, 'summary') || undefined,
    instructions: formTrimmed(formData, 'instructions') || undefined,
    priority: formTrimmed(formData, 'priority') || 'NORMAL',
    platformTargets: parseCommaList(formString(formData, 'platformTargets')),
    targetCountries: parseCommaList(formString(formData, 'targetCountries')).map((c) => c.toUpperCase()),
    targetLanguages: parseCommaList(formString(formData, 'targetLanguages')).map((l) => l.toLowerCase()),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(maxTesters ? { maxTesters } : {}),
  }

  const { id } = await serverFetch<ProjectResponse>('projects', { method: 'POST', body })

  revalidatePath('/app/customer/projects')
  redirect(`/app/customer/projects/${id}`)
}

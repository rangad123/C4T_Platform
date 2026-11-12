'use server'

import { revalidatePath } from 'next/cache'
import { redirect, RedirectType } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requireUser } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the automation page, shared by the admin and customer
 * portals (the API decides who may write). Each one redirects back to the
 * page with `?notice=` on success or `?error=` carrying the API's own
 * sentence on a refusal, so a 4xx reads as a message instead of a crash.
 */

const RETURN_PATH = /^\/app\/(admin|customer)\/projects\/[a-z0-9]{1,40}\/automation$/

async function run(
  formData: FormData,
  call: () => Promise<unknown>,
  success: string,
): Promise<never> {
  await requireUser()
  const path = formTrimmed(formData, 'returnTo') ?? ''
  const back = RETURN_PATH.test(path) ? path : '/'
  const buildId = formTrimmed(formData, 'buildId')

  const params = new URLSearchParams()
  if (buildId) params.set('buildId', buildId)
  try {
    await call()
    params.set('notice', success)
  } catch (error) {
    const message =
      error instanceof ApiError && error.status < 500
        ? error.message
        : 'That could not be saved. Try again in a moment.'
    params.set('error', message.slice(0, 300))
  }

  revalidatePath(back)
  redirect(`${back}?${params.toString()}`, RedirectType.replace)
}

function count(formData: FormData, name: string): number {
  const value = Number(formTrimmed(formData, name) ?? '0')
  return Number.isFinite(value) ? Math.trunc(value) : -1
}

export async function addAutomationModule(formData: FormData): Promise<void> {
  const projectId = formTrimmed(formData, 'projectId') ?? ''
  const optional = (name: string) => formTrimmed(formData, name) || undefined
  await run(
    formData,
    () =>
      actionFetch(`automation/projects/${encodeURIComponent(projectId)}/modules`, {
        method: 'POST',
        body: {
          buildId: optional('buildId'),
          name: formTrimmed(formData, 'name') ?? '',
          framework: optional('framework'),
          repositoryUrl: optional('repositoryUrl'),
          owner: optional('owner'),
        },
      }),
    'module-added',
  )
}

export async function deleteAutomationModule(formData: FormData): Promise<void> {
  const moduleId = formTrimmed(formData, 'moduleId') ?? ''
  await run(
    formData,
    () => actionFetch(`automation/modules/${encodeURIComponent(moduleId)}`, { method: 'DELETE' }),
    'module-removed',
  )
}

export async function addAutomationReport(formData: FormData): Promise<void> {
  const projectId = formTrimmed(formData, 'projectId') ?? ''
  const optional = (name: string) => formTrimmed(formData, name) || undefined
  const minutes = formTrimmed(formData, 'durationMinutes')
  await run(
    formData,
    () =>
      actionFetch(`automation/projects/${encodeURIComponent(projectId)}/reports`, {
        method: 'POST',
        body: {
          buildId: optional('buildId'),
          moduleId: optional('moduleId'),
          runAt: formTrimmed(formData, 'runAt') ?? '',
          passed: count(formData, 'passed'),
          failed: count(formData, 'failed'),
          skipped: count(formData, 'skipped'),
          durationSeconds: minutes ? Math.round(Number(minutes) * 60) : undefined,
          fileId: optional('fileId'),
          notes: optional('notes'),
        },
      }),
    'report-added',
  )
}

export async function deleteAutomationReport(formData: FormData): Promise<void> {
  const reportId = formTrimmed(formData, 'reportId') ?? ''
  await run(
    formData,
    () => actionFetch(`automation/reports/${encodeURIComponent(reportId)}`, { method: 'DELETE' }),
    'report-removed',
  )
}

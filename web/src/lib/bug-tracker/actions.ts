'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError, type ValidationDetail } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the Jira connection and bug export.
 *
 * Every export here is an async function (a `'use server'` module with any
 * other export unregisters its actions). The API makes every access decision;
 * the role check here is because a Server Action is a public POST endpoint.
 * A refusal comes back as the API's own message in `?error=`, never a crash.
 */

const SIGNED_IN = ['CUSTOMER', 'ADMIN', 'SUB_ADMIN'] as const

/** Only our own pages, so a tampered form cannot redirect elsewhere. */
function backTo(formData: FormData): string {
  const back = formTrimmed(formData, 'back')
  return /^\/app\/[A-Za-z0-9/_-]+$/.test(back) ? back : '/app'
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const first = Array.isArray(error.details)
      ? (error.details[0] as Partial<ValidationDetail> | undefined)
      : undefined
    return (first?.message ?? error.message).slice(0, 240)
  }
  return 'The service is unreachable. Try again in a moment.'
}

function withParam(path: string, key: string, value: string): string {
  return `${path}?${new URLSearchParams({ [key]: value }).toString()}`
}

async function run(
  back: string,
  notice: string,
  call: () => Promise<unknown>,
  params = { notice: 'notice', error: 'error' },
): Promise<never> {
  let error: string | null = null
  try {
    await call()
  } catch (e) {
    error = messageOf(e)
  }
  revalidatePath(back)
  // Outside the try: `redirect` works by throwing.
  redirect(error ? withParam(back, params.error, error) : withParam(back, params.notice, notice))
}

export async function saveBugTrackerConnection(formData: FormData): Promise<void> {
  await requireRole([...SIGNED_IN])
  const back = backTo(formData)
  const orgId = formTrimmed(formData, 'orgId')
  const apiToken = formTrimmed(formData, 'apiToken')
  await run(back, 'jira-saved', () =>
    actionFetch(`bug-tracker/organisations/${encodeURIComponent(orgId)}`, {
      method: 'PUT',
      body: {
        siteUrl: formTrimmed(formData, 'siteUrl'),
        accountEmail: formTrimmed(formData, 'accountEmail'),
        projectKey: formTrimmed(formData, 'projectKey'),
        issueType: formTrimmed(formData, 'issueType') || 'Bug',
        ...(apiToken ? { apiToken } : {}),
      },
    }),
  )
}

export async function testBugTrackerConnection(formData: FormData): Promise<void> {
  await requireRole([...SIGNED_IN])
  const back = backTo(formData)
  const orgId = formTrimmed(formData, 'orgId')
  await run(back, 'jira-tested', () =>
    actionFetch(`bug-tracker/organisations/${encodeURIComponent(orgId)}/test`, { method: 'POST' }),
  )
}

export async function removeBugTrackerConnection(formData: FormData): Promise<void> {
  await requireRole([...SIGNED_IN])
  const back = backTo(formData)
  const orgId = formTrimmed(formData, 'orgId')
  await run(back, 'jira-removed', () =>
    actionFetch(`bug-tracker/organisations/${encodeURIComponent(orgId)}`, { method: 'DELETE' }),
  )
}

export async function exportBugToJira(formData: FormData): Promise<void> {
  await requireRole([...SIGNED_IN])
  const back = backTo(formData)
  const bugId = formTrimmed(formData, 'bugId')
  await run(
    back,
    'jira-exported',
    () => actionFetch(`bug-tracker/bugs/${encodeURIComponent(bugId)}/export`, { method: 'POST' }),
    // Bug pages already use `error` for their own panels.
    { notice: 'jira', error: 'jiraError' },
  )
}

/** The admin bug list's bulk form: the ticked `ids`. */
export async function bulkExportBugsToJira(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const back = '/app/admin/bugs'
  const ids = formData
    .getAll('ids')
    .map((v) => (typeof v === 'string' ? v : ''))
    .filter(Boolean)
    .slice(0, 50)
  if (ids.length === 0) redirect(withParam(back, 'error', 'Tick the bugs to export first.'))

  let outcome: { exported: unknown[]; skipped: unknown[] } | null = null
  let error: string | null = null
  try {
    outcome = await actionFetch('bug-tracker/bugs/bulk-export', { method: 'POST', body: { ids } })
  } catch (e) {
    error = messageOf(e)
  }
  revalidatePath(back)
  if (error) redirect(withParam(back, 'error', error))
  const params = new URLSearchParams({
    notice: 'jira-bulk',
    exported: String(outcome?.exported.length ?? 0),
    skipped: String(outcome?.skipped.length ?? 0),
  })
  redirect(`${back}?${params.toString()}`)
}

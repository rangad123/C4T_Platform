'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const LIST_PATH = '/app/tester/bugs'
const NEW_PATH = '/app/tester/bugs/new'

const SEVERITIES: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const REPRODUCIBILITIES: readonly string[] = ['ALWAYS', 'SOMETIMES', 'RARELY', 'ONCE']
const BUG_TYPES: readonly string[] = [
  'CRASH',
  'APP_FREEZE',
  'FUNCTIONAL',
  'UI',
  'UX',
  'SECURITY',
  'PERFORMANCE',
]

/**
 * Maps an API failure to one of the reason codes `new/page.tsx` renders.
 * Nothing from the API's message is echoed into the page — only these fixed
 * codes cross the boundary, and the page owns the copy for each.
 */
function reasonFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 404) return 'missing'
    if (error.status === 409) return 'closed'
    if (error.status === 422 || error.status === 400) return 'invalid'
  }
  return 'failed'
}

/**
 * Files a defect against a project the tester is assigned to.
 *
 * The API enforces the real rule — `bug.create` requires an accepted or
 * active assignment, and the service additionally refuses projects in
 * DRAFT/COMPLETED/CANCELLED. This action does not re-implement either check;
 * it only narrows the enum fields so a tampered form cannot smuggle an
 * unknown value past the page's own `<select>` options, and converts a
 * failure into a reason code the form can render inline.
 */
export async function reportBugAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const projectId = formTrimmed(formData, 'projectId')
  const title = formTrimmed(formData, 'title')
  const description = formTrimmed(formData, 'description')
  const stepsToReproduce = formTrimmed(formData, 'stepsToReproduce')
  const expectedResult = formTrimmed(formData, 'expectedResult')
  const actualResult = formTrimmed(formData, 'actualResult')

  const severityInput = formTrimmed(formData, 'severity')
  const severity = SEVERITIES.includes(severityInput) ? severityInput : 'MEDIUM'
  const reproInput = formTrimmed(formData, 'reproducibility')
  const reproducibility = REPRODUCIBILITIES.includes(reproInput) ? reproInput : 'ALWAYS'
  const typeInput = formTrimmed(formData, 'type')
  const type = BUG_TYPES.includes(typeInput) ? typeInput : undefined

  const deviceModel = formTrimmed(formData, 'deviceModel')
  const osName = formTrimmed(formData, 'osName')
  const osVersion = formTrimmed(formData, 'osVersion')
  const browser = formTrimmed(formData, 'browser')
  const appVersion = formTrimmed(formData, 'appVersion')
  const networkType = formTrimmed(formData, 'networkType')

  // Contributed by <EvidenceUpload>, one hidden input per finished upload.
  // Each id already points at a completed FileObject owned by this user —
  // `createBug` re-checks both, so a forged id fails there rather than here.
  const attachmentFileIds = formData
    .getAll('attachmentFileIds')
    .map((v) => (typeof v === 'string' ? v : ''))
    .filter(Boolean)

  // The API's own minimums. Bailing here rather than posting a request we
  // know will 422 — the fields carry the same limits as native constraints,
  // so this is only reachable from a hand-built post.
  if (!projectId || title.length < 5 || description.length < 10 || stepsToReproduce.length < 5) {
    redirect(`${NEW_PATH}?error=invalid`)
  }

  let reason: string | null = null
  try {
    await serverFetch<{ id: string }>('bugs', {
      method: 'POST',
      body: {
        projectId,
        title,
        description,
        stepsToReproduce,
        severity,
        reproducibility,
        ...(type ? { type } : {}),
        ...(expectedResult ? { expectedResult } : {}),
        ...(actualResult ? { actualResult } : {}),
        ...(deviceModel ? { deviceModel } : {}),
        ...(osName ? { osName } : {}),
        ...(osVersion ? { osVersion } : {}),
        ...(browser ? { browser } : {}),
        ...(appVersion ? { appVersion } : {}),
        ...(networkType ? { networkType } : {}),
        ...(attachmentFileIds.length > 0 ? { attachmentFileIds } : {}),
      },
    })
  } catch (error) {
    reason = reasonFor(error)
  }

  revalidatePath(LIST_PATH)
  // Outside any try/catch on purpose — `redirect` works by throwing.
  redirect(reason ? `${NEW_PATH}?error=${reason}` : `${LIST_PATH}?reported=1`)
}

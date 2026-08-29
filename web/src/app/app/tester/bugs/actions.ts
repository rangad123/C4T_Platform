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
/** Prefix every custom-field control posts under — see `CustomFieldInput`. */
const CUSTOM_PREFIX = 'custom:'

/**
 * How several CHECKBOX choices pack into one stored value.
 *
 * Must match the API's separator (see `BugCustomValue` in the schema): a
 * newline, because an option label is capped single-line text and cannot
 * contain one, whereas a comma would collide with labels containing commas.
 */
const CUSTOM_ANSWER_SEPARATOR = String.fromCharCode(10)

export async function reportBugAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const projectId = formTrimmed(formData, 'projectId')
  const buildId = formTrimmed(formData, 'buildId')
  const featureId = formTrimmed(formData, 'featureId')
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

  const preCondition = formTrimmed(formData, 'preCondition')
  const videoUrl = formTrimmed(formData, 'videoUrl')
  const occurrenceRaw = formTrimmed(formData, 'occurrence')
  const outOfRaw = formTrimmed(formData, 'outOf')
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
  /**
   * Errors send the tester back to the form. Carrying the project and build
   * along means the picker reopens on what they were reporting against —
   * without it, a rejected submit silently reassigns the report to whichever
   * project happens to sort first, which is a far worse outcome than the
   * error itself.
   */
  const back = (code: string): string => {
    const sp = new URLSearchParams({ error: code })
    if (projectId) sp.set('projectId', projectId)
    if (buildId) sp.set('buildId', buildId)
    return `${NEW_PATH}?${sp.toString()}`
  }

  // know will 422 — the fields carry the same limits as native constraints,
  // so this is only reachable from a hand-built post.
  if (!projectId || title.length < 5 || description.length < 10 || stepsToReproduce.length < 5) {
    redirect(back('invalid'))
  }

  /**
   * A defect nobody can see is a defect nobody can fix. The legacy platform
   * enforced this too ("Please enter Bug Video or Screenshots"), and it is a
   * product rule rather than an API one — `createBugSchema` accepts a report
   * with no attachments, because an admin filing on a tester's behalf may
   * genuinely have none. So it is checked here, where the rule belongs.
   */
  if (attachmentFileIds.length === 0 && !videoUrl) {
    redirect(back('evidence'))
  }

  /**
   * The API refuses an occurrence without its denominator (and vice versa),
   * and refuses one larger than the other. Catching the pairing here turns
   * what would be an opaque 422 into the same inline message every other
   * validation failure on this form produces.
   */
  const occurrence = occurrenceRaw ? Number(occurrenceRaw) : undefined
  const outOf = outOfRaw ? Number(outOfRaw) : undefined
  if ((occurrence === undefined) !== (outOf === undefined)) {
    redirect(back('occurrence-pair'))
  }
  if (occurrence !== undefined && outOf !== undefined && occurrence > outOf) {
    redirect(back('occurrence-range'))
  }

  /**
   * The client's extra answers for this build (§72).
   *
   * Each control posts under `custom:<fieldId>`, so the field id travels with
   * its own value — no parallel list of ids, no JSON blob. `getAll` is what
   * makes CHECKBOX work: the browser sends one entry per ticked box under the
   * same name, joined here with the separator the API expects.
   *
   * Nothing is validated here. Which field is required, and whether a value is
   * one of a dropdown's options, is the API's to decide against the build's own
   * definitions — an unknown id is rejected there rather than dropped here.
   */
  const customAnswers = [
    ...new Set([...formData.keys()].filter((key) => key.startsWith(CUSTOM_PREFIX))),
  ].flatMap((key) => {
    const value = formData
      .getAll(key)
      .map(String)
      .map((v) => v.trim())
      .filter(Boolean)
      .join(CUSTOM_ANSWER_SEPARATOR)
    return value ? [{ fieldId: key.slice(CUSTOM_PREFIX.length), value }] : []
  })

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
        ...(buildId ? { buildId } : {}),
        ...(featureId ? { featureId } : {}),
        ...(preCondition ? { preCondition } : {}),
        ...(videoUrl ? { videoUrl } : {}),
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(outOf !== undefined ? { outOf } : {}),
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
        ...(customAnswers.length > 0 ? { customAnswers } : {}),
      },
    })
  } catch (error) {
    reason = reasonFor(error)
  }

  revalidatePath(LIST_PATH)
  // Outside any try/catch on purpose — `redirect` works by throwing.
  redirect(reason ? back(reason) : `${LIST_PATH}?reported=1`)
}

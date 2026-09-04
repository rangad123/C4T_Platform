'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { closeModal } from '@/lib/navigation/close-modal'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for a tester's own bug.
 *
 * What a tester may do to a bug is narrow, and the API decides it — not this
 * file. `GET /bugs/:id` returns a `capabilities` block plus
 * `availableTransitions`, and the page renders controls strictly from those.
 * These actions re-post what the page offered; the API re-checks everything.
 *
 * Deliberately NOT here: severity changes (platform-only), classification
 * (`bug.triage`), and internal comments (`bug.comment_internal`). A tester
 * holds none of those, so no action exists to attempt them.
 */

const DETAIL_BASE = '/app/tester/bugs'
const PROJECTS_PATH = '/app/tester/projects'

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

function detailPath(id: string): string {
  return `${DETAIL_BASE}/${id}`
}

function failurePath(id: string, panel: string, reason: string): string {
  return `${detailPath(id)}?error=${panel}:${reason}`
}

/**
 * Fields the edit form actually has, so a rejection can name one.
 *
 * An allow-list, not free text. `ApiError` carries the API's own sentences,
 * and echoing one through the URL would break this page's rule that nothing
 * from the query string reaches the reader (see `panelError`) — a crafted
 * link could otherwise put any words in the app's mouth. Passing a token the
 * page must recognise keeps that guarantee: the page still renders only copy
 * it owns, and an unknown token renders nothing.
 */
const EDITABLE_FIELDS: readonly string[] = [
  'title',
  'description',
  'preCondition',
  'stepsToReproduce',
  'expectedResult',
  'actualResult',
  'severity',
  'reproducibility',
  'occurrence',
  'outOf',
  'type',
  'featureId',
  'videoUrl',
  'deviceModel',
  'osName',
  'osVersion',
  'browser',
  'appVersion',
  'networkType',
]

/**
 * Which field the API rejected, if it named one this form has.
 *
 * Nothing read `error.details` before, so a rejected save said only "The API
 * rejected that. Check the values and try again." on a form with nineteen
 * fields — leaving the reader to hunt. The API knows exactly which field, and
 * now the page can say so in its own words.
 */
function rejectedField(error: unknown): string | null {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return null
  for (const d of error.details) {
    if (d && typeof d === 'object' && 'field' in d) {
      const field = String((d as { field: unknown }).field)
      if (EDITABLE_FIELDS.includes(field)) return field
    }
  }
  return null
}

function reasonFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 404) return 'missing'
    if (error.status === 409) return 'conflict'
    if (error.status === 422 || error.status === 400) return 'invalid'
  }
  return 'failed'
}

/** Post a comment. Never internal — a tester cannot post one, and the API refuses. */
export async function addBugComment(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(PROJECTS_PATH)

  const body = formTrimmed(formData, 'body')
  if (!body) redirect(failurePath(id, 'comment', 'empty'))

  let reason: string | null = null
  try {
    await actionFetch(`bugs/${id}/comments`, { method: 'POST', body: { body, isInternal: false } })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'comment', reason))

  revalidatePath(`${DETAIL_BASE}/${id}`)
  revalidatePath(detailPath(id))
  redirect(`${detailPath(id)}?section=comments`)
}

/**
 * Move the bug's status.
 *
 * The transitions a tester actually holds are narrow — the API grants a
 * reporter `FIXED → VERIFIED | REOPENED` and `VERIFIED → REOPENED`, i.e.
 * confirming or rejecting a fix on their own report. The page builds its
 * `<Select>` from `capabilities.availableTransitions` verbatim, so anything
 * reaching here was offered by the API in the first place.
 */
export async function moveBugStatus(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(PROJECTS_PATH)

  const status = formTrimmed(formData, 'status')
  if (!status) redirect(failurePath(id, 'status', 'no-change'))

  const note = formTrimmed(formData, 'note')

  let reason: string | null = null
  try {
    await actionFetch(`bugs/${id}/status`, {
      method: 'POST',
      body: { status, ...(note ? { note } : {}) },
    })
  } catch (error) {
    reason = reasonFor(error)
  }
  if (reason) redirect(failurePath(id, 'status', reason))

  revalidatePath(`${DETAIL_BASE}/${id}`)
  revalidatePath(detailPath(id))
  redirect(detailPath(id))
}

/**
 * Correct the report itself — everything `updateBugSchema` allows a
 * reporter to touch. The API is what actually enforces the "still NEW"
 * window (`canReporterEdit`); the page only shows the "Edit" button when
 * `capabilities.canEdit` said so, and this action re-posts whatever the
 * modal held, exactly like `moveBugStatus` above.
 *
 * Every field is sent, blank or not — same reasoning as
 * `updateBasicInfoAction` on the tester profile: omitting a cleared field
 * would silently leave the old value in place instead of erasing it. The
 * exception is `occurrence`/`outOf`, which the schema has no way to null out
 * (`z.coerce.number().optional()`, not nullable) — so, as on creation, they
 * are sent only as a matched pair and otherwise left untouched.
 */
export async function updateBugAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(PROJECTS_PATH)

  const title = formTrimmed(formData, 'title')
  const description = formTrimmed(formData, 'description')
  const stepsToReproduce = formTrimmed(formData, 'stepsToReproduce')
  const expectedResult = formTrimmed(formData, 'expectedResult')
  const actualResult = formTrimmed(formData, 'actualResult')
  const preCondition = formTrimmed(formData, 'preCondition')
  const videoUrl = formTrimmed(formData, 'videoUrl')
  const featureId = formTrimmed(formData, 'featureId')
  const deviceModel = formTrimmed(formData, 'deviceModel')
  const osName = formTrimmed(formData, 'osName')
  const osVersion = formTrimmed(formData, 'osVersion')
  const browser = formTrimmed(formData, 'browser')
  const appVersion = formTrimmed(formData, 'appVersion')
  const networkType = formTrimmed(formData, 'networkType')

  const severityInput = formTrimmed(formData, 'severity')
  const severity = SEVERITIES.includes(severityInput) ? severityInput : undefined
  const reproInput = formTrimmed(formData, 'reproducibility')
  const reproducibility = REPRODUCIBILITIES.includes(reproInput) ? reproInput : undefined
  const typeInput = formTrimmed(formData, 'type')
  const type = typeInput && BUG_TYPES.includes(typeInput) ? typeInput : null

  const occurrenceRaw = formTrimmed(formData, 'occurrence')
  const outOfRaw = formTrimmed(formData, 'outOf')
  if (Boolean(occurrenceRaw) !== Boolean(outOfRaw)) {
    closeModal(failurePath(id, 'report', 'occurrence-pair'))
  }
  const occurrence = occurrenceRaw ? Number(occurrenceRaw) : undefined
  const outOf = outOfRaw ? Number(outOfRaw) : undefined
  if (occurrence !== undefined && outOf !== undefined && occurrence > outOf) {
    closeModal(failurePath(id, 'report', 'occurrence-range'))
  }

  let reason: string | null = null
  let caught: unknown = null
  try {
    await actionFetch(`bugs/${id}`, {
      method: 'PATCH',
      body: {
        title,
        description,
        stepsToReproduce,
        expectedResult,
        actualResult,
        preCondition,
        videoUrl,
        featureId: featureId || null,
        type,
        deviceModel,
        osName,
        osVersion,
        browser,
        appVersion,
        networkType,
        ...(severity ? { severity } : {}),
        ...(reproducibility ? { reproducibility } : {}),
        ...(occurrence !== undefined && outOf !== undefined ? { occurrence, outOf } : {}),
      },
    })
  } catch (error) {
    reason = reasonFor(error)
    caught = error
  }
  if (reason) {
    const field = rejectedField(caught)
    closeModal(
      field
        ? `${failurePath(id, 'report', reason)}&field=${field}`
        : failurePath(id, 'report', reason),
    )
  }

  revalidatePath(detailPath(id))
  /*
    `closeModal`, not `redirect`: this save was submitted from the Edit report
    modal, whose open state IS the URL. A pushed redirect left that URL in
    history, so Back reopened the modal on changes already saved.
  */
  closeModal(detailPath(id))
}

'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

/**
 * Server Actions for the tester verification workflow (§2.2 "Onboard, verify,
 * manage, and monitor the crowd tester pool").
 *
 * Both actions hit the same endpoint — `PATCH testers/:id/status` — but they are
 * two separate exports because the API's schema refines the body: a reason is
 * mandatory when the target status is REJECTED and meaningless otherwise. One
 * form cannot mark a field `required` conditionally without client state, so the
 * split is in the actions rather than in a `useState` on the page:
 * `setTesterStatus` handles the four transitions that need no reason, and
 * `rejectTester` owns the one that does and can therefore mark it `required` in
 * the markup.
 *
 * EVERY export here is an async function. Exporting the status tuple below would
 * silently unregister both actions and fail the forms at runtime, so it stays
 * module-private and the page keeps its own copy for the select options.
 *
 * `requirePermission` runs inside each action, not just at render time: an action
 * is a POST endpoint reachable without going through the page, so the gate has to
 * be here too. The API enforces `tester.verify` independently — this only avoids
 * a pointless round trip and sends the wrong role home.
 */

const TESTER_STATUSES = ['APPLIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const

type TesterStatusValue = (typeof TESTER_STATUSES)[number]

function isTesterStatus(value: string): value is TesterStatusValue {
  return (TESTER_STATUSES as readonly string[]).includes(value)
}

/**
 * The one write. `reason` is omitted from the body rather than sent as null,
 * because the schema types it as an optional string and an explicit null earns a
 * 422 that the form has no way to show.
 */
async function patchTesterStatus(
  id: string,
  status: TesterStatusValue,
  reason?: string,
): Promise<void> {
  let notice = 'tester-status-saved'
  try {
    await actionFetch<unknown>(`testers/${id}/status`, {
      method: 'PATCH',
      body: reason ? { status, reason } : { status },
    })
  } catch (error) {
    const code = error instanceof ApiError ? error.status : 0
    notice =
      code === 403
        ? 'tester-status-forbidden'
        : code === 409 || code === 400 || code === 422
          ? 'tester-status-illegal'
          : 'tester-status-failed'
  }

  // The pool list shows status, and the detail page shows the whole workflow.
  revalidatePath('/app/admin/testers')
  revalidatePath(`/app/admin/testers/${id}`)
  redirect(`/app/admin/testers/${id}?notice=${notice}`)
}

/**
 * Moves a tester between APPLIED, UNDER_REVIEW, VERIFIED and SUSPENDED.
 *
 * REJECTED is refused here even if it is posted by hand, so the reason
 * requirement cannot be sidestepped by editing the select's options.
 */
export async function setTesterStatus(formData: FormData): Promise<void> {
  await requirePermission('tester.verify')

  const id = formTrimmed(formData, 'id')
  const status = formTrimmed(formData, 'status')
  const note = formTrimmed(formData, 'note')

  if (!id || !isTesterStatus(status) || status === 'REJECTED') return

  await patchTesterStatus(id, status, note || undefined)
}

/** Rejects an application. The reason is required and reaches the tester. */
export async function rejectTester(formData: FormData): Promise<void> {
  await requirePermission('tester.verify')

  const id = formTrimmed(formData, 'id')
  const reason = formTrimmed(formData, 'reason')

  if (!id || !reason) return

  await patchTesterStatus(id, 'REJECTED', reason)
}

export interface RevealedPaymentDetails {
  accountName?: string
  accountNumber?: string
  ifscCode?: string
  paypalEmail?: string
  paytmNumber?: string
}

export type RevealPaymentAccountResult =
  { ok: true; details: RevealedPaymentDetails } | { ok: false; message: string }

/**
 * Called directly from `RevealPaymentDetails` (a client component) rather
 * than via a `<form action>` — the result has to flow back into that
 * component's state to render inline, and a form submit has no return value
 * a client component can read. Nothing here writes the plaintext anywhere:
 * not a cookie, not the URL, not a log. React holds it in memory for as long
 * as the component is mounted and forgets it on navigation or refresh.
 *
 * `requirePermission` re-checks `payment_account.decrypt` even though the
 * page that renders the reveal button already gated on it — same reasoning
 * as every other action in this file: a Server Action is a reachable POST
 * endpoint independent of the page. The API re-checks a third time and is
 * the actual security boundary; this and the page gate are both UX, and the
 * API is additionally what enforces the step-up password check and the
 * per-account rate limit.
 */
export async function revealPaymentAccountAction(
  paymentAccountId: string,
  password: string,
): Promise<RevealPaymentAccountResult> {
  await requirePermission('payment_account.decrypt')

  try {
    const details = await actionFetch<RevealedPaymentDetails>(
      `payment-accounts/${paymentAccountId}/reveal`,
      { method: 'POST', body: { password } },
    )
    return { ok: true, details }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { ok: false, message: 'Incorrect password.' }
    }
    if (error instanceof ApiError && error.status === 429) {
      return { ok: false, message: 'Too many attempts. Try again in a few minutes.' }
    }
    return { ok: false, message: 'Could not reveal these details. Try again.' }
  }
}

/**
 * Rate a tester on a project they worked on (§2.2 "Ratings & Reviews").
 *
 * The delivery team can leave ratings, not only moderate them. The API is the
 * enforcement point, as everywhere else here: it checks `rating.write`,
 * refuses a subject who was never on the named project, and refuses a second
 * rating from the same author on the same project. This action only shapes
 * the body and turns a refusal into a notice code the page owns the copy for.
 *
 * `returnTo` exists because the same rating can be left from two places — the
 * tester record and a build's assignment list — and each should return to
 * where it started rather than teleporting the person to the other one. Only
 * a path inside the admin portal is accepted; an unchecked one is an open
 * redirect.
 */
export async function rateTesterAction(formData: FormData): Promise<void> {
  await requirePermission('rating.write')

  const testerProfileId = formTrimmed(formData, 'testerProfileId')
  const subjectUserId = formTrimmed(formData, 'subjectUserId')
  const projectId = formTrimmed(formData, 'projectId')
  const score = Number(formTrimmed(formData, 'score'))
  const comment = formTrimmed(formData, 'comment')

  const requested = formTrimmed(formData, 'returnTo')
  const returnTo =
    requested.startsWith('/app/admin/') && !requested.startsWith('//') ? requested : null

  const base = returnTo ?? `/app/admin/testers/${testerProfileId}?section=ratings`
  const withNotice = (notice: string) => `${base}${base.includes('?') ? '&' : '?'}notice=${notice}`

  if (!subjectUserId) return
  if (!returnTo && !testerProfileId) return
  if (!projectId) redirect(withNotice('rating-needs-project'))
  if (!Number.isInteger(score) || score < 1 || score > 5) redirect(withNotice('rating-invalid'))

  try {
    await actionFetch('ratings', {
      method: 'POST',
      body: {
        subjectType: 'TESTER',
        subjectUserId,
        projectId,
        score,
        ...(comment ? { comment } : {}),
      },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    const notice =
      status === 409
        ? 'rating-duplicate'
        : status === 400
          ? 'rating-not-worked-together'
          : status === 403
            ? 'rating-forbidden'
            : 'rating-failed'
    redirect(withNotice(notice))
  }

  revalidatePath(base)
  redirect(withNotice('rating-saved'))
}

/**
 * Award a badge to a tester for their work on a project.
 *
 * The same shape as `rateTesterAction` above, and deliberately the same
 * permission: on the API a badge goes through `assertWorkedTogether`, the
 * very rule that governs a rating, so anyone entitled to rate is entitled to
 * recognise, and nobody else is. The API remains the enforcement point —
 * this only shapes the body and maps a refusal onto a notice code.
 */
export async function awardBadgeAction(formData: FormData): Promise<void> {
  await requirePermission('rating.write')

  const testerProfileId = formTrimmed(formData, 'testerProfileId')
  const testerUserId = formTrimmed(formData, 'testerUserId')
  const projectId = formTrimmed(formData, 'projectId')
  const badgeId = formTrimmed(formData, 'badgeId')
  const note = formTrimmed(formData, 'note')

  const requested = formTrimmed(formData, 'returnTo')
  const returnTo =
    requested.startsWith('/app/admin/') && !requested.startsWith('//') ? requested : null

  const base = returnTo ?? `/app/admin/testers/${testerProfileId}?section=ratings`
  const withNotice = (notice: string) => `${base}${base.includes('?') ? '&' : '?'}notice=${notice}`

  if (!testerUserId) return
  if (!returnTo && !testerProfileId) return
  if (!projectId || !badgeId) redirect(withNotice('badge-invalid'))

  try {
    await actionFetch('badges/awards', {
      method: 'POST',
      body: { badgeId, testerUserId, projectId, ...(note ? { note } : {}) },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    const notice =
      status === 409
        ? 'badge-duplicate'
        : status === 400
          ? 'badge-not-worked-together'
          : status === 403
            ? 'badge-forbidden'
            : 'badge-failed'
    redirect(withNotice(notice))
  }

  revalidatePath(base)
  redirect(withNotice('badge-awarded'))
}

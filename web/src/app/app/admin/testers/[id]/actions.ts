'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

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
  await serverFetch<unknown>(`testers/${id}/status`, {
    method: 'PATCH',
    body: reason ? { status, reason } : { status },
  })

  // The pool list shows status, and the detail page shows the whole workflow.
  revalidatePath('/app/admin/testers')
  revalidatePath(`/app/admin/testers/${id}`)
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

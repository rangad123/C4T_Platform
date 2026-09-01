'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the tester's build workspace.
 *
 * Only one write belongs to a tester here: answering an invitation. Every
 * other control on the page is a read or a link — a tester does not edit the
 * brief, the build, the roster or the materials, and the API would refuse if
 * they tried.
 *
 * Every export is an async function. A `const` or `type` exported from a
 * `'use server'` module silently unregisters every action in the file.
 */

const LIST_PATH = '/app/tester/projects'

function detailPath(id: string): string {
  return `${LIST_PATH}/${id}`
}

function reasonFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 404) return 'missing'
    // The service throws 409 when the invitation was already answered — most
    // often the tester answered in another tab, so the page just needs a
    // reload rather than an apology.
    if (error.status === 409) return 'answered'
  }
  return 'failed'
}

/**
 * Accept or decline an invitation.
 *
 * `POST /v1/projects/:id/respond` only accepts ACCEPTED or DECLINED, and only
 * while the assignment is still INVITED — the API owns both rules. This
 * narrows the value so a hand-posted body cannot smuggle e.g. `COMPLETED`
 * through a field the page never rendered.
 */
export async function respondToInvitation(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  if (!id) redirect(LIST_PATH)

  const raw = formTrimmed(formData, 'response')
  if (raw !== 'ACCEPTED' && raw !== 'DECLINED') {
    redirect(`${detailPath(id)}?notice=invalid`)
  }

  const notes = formTrimmed(formData, 'notes')

  let notice = raw === 'ACCEPTED' ? 'accepted' : 'declined'
  try {
    await actionFetch(`projects/${id}/respond`, {
      method: 'POST',
      body: { response: raw, ...(notes ? { notes } : {}) },
    })
    revalidatePath(LIST_PATH)
    revalidatePath(detailPath(id))
  } catch (error) {
    notice = reasonFor(error)
  }

  redirect(`${detailPath(id)}?notice=${notice}`)
}

/**
 * Record the outcome of a test case assigned to this tester.
 *
 * `POST /test-cases/:id/reports` has existed since the testing module was
 * written and no portal called it, so a tester could be assigned a scripted
 * check and had nowhere to say what happened. The Test reports tab lists the
 * cases; this is what closes the loop.
 *
 * The API owns the rules — that the case is assigned to this tester, that
 * the build is still open — and this only narrows `result` to the enum so a
 * hand-built post cannot smuggle a value past the page's own select.
 */
export async function reportTestResult(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const id = formTrimmed(formData, 'id')
  const testCaseId = formTrimmed(formData, 'testCaseId')
  if (!id || !testCaseId) redirect(LIST_PATH)

  const back = (notice: string) => `${detailPath(id)}?section=testing&notice=${notice}`

  const result = formTrimmed(formData, 'result')
  if (!['PASS', 'FAIL', 'BLOCKED', 'NOT_TESTED'].includes(result)) {
    redirect(back('result-invalid'))
  }

  const notes = formTrimmed(formData, 'notes')
  const devices = formTrimmed(formData, 'devices')
  const browsers = formTrimmed(formData, 'browsers')

  let notice = 'result-saved'
  try {
    await actionFetch(`test-cases/${testCaseId}/reports`, {
      method: 'POST',
      body: {
        result,
        ...(notes ? { notes } : {}),
        ...(devices ? { devices } : {}),
        ...(browsers ? { browsers } : {}),
      },
    })
    revalidatePath(detailPath(id))
  } catch (error) {
    notice = reasonFor(error)
  }

  redirect(back(notice))
}

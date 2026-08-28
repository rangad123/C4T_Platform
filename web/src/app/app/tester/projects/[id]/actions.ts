'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
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
    await serverFetch(`projects/${id}/respond`, {
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

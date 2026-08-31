'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

/**
 * Rating a tester you have worked with.
 *
 * The rules are the API's and stay there: it checks that the author and the
 * subject actually shared the project (`assertWorkedTogether`), that nobody
 * rates themselves, and that a project is named — ratings are always tied to
 * one piece of work, never to a person in the abstract. Duplicates come back
 * as a 409 because one author rates one subject once per project.
 *
 * Administrators cannot post ratings at all; that is the API's rule too, and
 * the reason there is no equivalent of this on the admin side. They moderate
 * ratings instead.
 */
export async function rateTesterAction(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const testerProfileId = formTrimmed(formData, 'testerProfileId')
  const subjectUserId = formTrimmed(formData, 'subjectUserId')
  const projectId = formTrimmed(formData, 'projectId')
  const score = Number(formTrimmed(formData, 'score'))
  const comment = formTrimmed(formData, 'comment')

  /**
   * Where to land afterwards.
   *
   * A rating can be left from the tester's profile or from the assignment on
   * a project, and each should return to where it started rather than
   * teleporting the person somewhere else. That is the ONLY difference
   * between the two — same action, same endpoint, same rules — so it is one
   * field rather than a second copy of this function.
   *
   * Only a path within this portal is accepted: `returnTo` arrives from a
   * form field, and an unchecked one is an open redirect.
   */
  const requested = formTrimmed(formData, 'returnTo')
  const returnTo =
    requested.startsWith('/app/customer/') && !requested.startsWith('//') ? requested : null

  const base = returnTo ?? `/app/customer/crowdtesters/${testerProfileId}`
  const withNotice = (notice: string) => `${base}${base.includes('?') ? '&' : '?'}notice=${notice}`

  if (!subjectUserId) return
  if (!returnTo && !testerProfileId) return
  if (!projectId) redirect(withNotice('rating-needs-project'))
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(withNotice('rating-invalid'))
  }

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

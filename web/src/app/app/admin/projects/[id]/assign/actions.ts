'use server'

import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'

/**
 * Invite the selected testers onto the build.
 *
 * Returns its result rather than redirecting, which is the opposite of every
 * other mutation in this portal and deliberate: the workspace has to report
 * how many were invited AND how many the API skipped, and a redirect can only
 * carry one notice code. The caller shows the outcome in place and offers the
 * roster as a link.
 *
 * `revalidatePath` still runs, so the roster and the project page are already
 * rebuilt by the time the reader follows that link — no manual refresh.
 */

export interface AssignResult {
  ok: boolean
  invited?: number
  reinvited?: number
  skipped?: number
  message?: string
}

export async function assignSelectedTesters(input: {
  projectId: string
  buildId: string
  testerIds: string[]
  notes?: string
  configurations?: { testerId: string; deviceId?: string | null; browserId?: string | null }[]
}): Promise<AssignResult> {
  await requirePermission('project.assign')

  if (!input.projectId || !input.buildId) {
    return { ok: false, message: 'That project or build is no longer available.' }
  }
  if (input.testerIds.length === 0) {
    return { ok: false, message: 'Select at least one tester first.' }
  }

  try {
    const result = await actionFetch<{ invited: number; reinvited: number; skipped: number }>(
      `projects/${input.projectId}/assignments`,
      {
        method: 'POST',
        body: {
          testerIds: input.testerIds,
          buildId: input.buildId,
          ...(input.notes ? { notes: input.notes } : {}),
          ...(input.configurations && input.configurations.length > 0
            ? { configurations: input.configurations }
            : {}),
        },
      },
    )

    revalidatePath(`/app/admin/projects/${input.projectId}`)
    return {
      ok: true,
      invited: result.invited,
      reinvited: result.reinvited,
      skipped: result.skipped,
    }
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    /**
     * Every one of these is a refusal the reader can act on, so each says
     * what to do rather than "something went wrong". 409 is the project not
     * being open for work; 400 covers the ownership check on a device or
     * browser that is not the tester's.
     */
    const message =
      status === 409
        ? 'This project is not accepting testers right now — check its status.'
        : status === 400
          ? (error as ApiError).message
          : status === 403
            ? 'You do not have permission to assign testers on this project.'
            : status === 404
              ? 'That project or build no longer exists. Reload and try again.'
              : 'The invitations could not be sent. Try again in a moment.'
    return { ok: false, message }
  }
}

'use server'

import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

const PATH = '/app/customer/remote-qa'

/** Trimmed value, or undefined when there was nothing but whitespace. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed
}

/**
 * Records a Remote QA enquiry as a real lead.
 *
 * ── WHY A LEAD
 *
 * Remote QA has no backend of its own — see the page for the full note. Rather
 * than a form that goes nowhere, this writes to the module the platform
 * already has for exactly this shape of request: `POST /v1/leads`, which an
 * admin works through at `/app/admin/leads` with a real status pipeline.
 *
 * `sourcePath` marks where it came from, so Remote QA enquiries are
 * distinguishable from marketing-site contact forms in that same list.
 */
export async function requestRemoteQaAction(formData: FormData): Promise<void> {
  const user = await requireRole(['CUSTOMER'])

  const message = formTrimmed(formData, 'message')
  if (!message) redirect(`${PATH}?notice=message`)

  try {
    await serverFetch('leads', {
      method: 'POST',
      body: {
        // Taken from the session, not the form: a signed-in enquiry should
        // carry the account that actually made it. `||` semantics are wanted
        // here — a blank name must fall through to the placeholder, and `??`
        // would keep the empty string — so the fallback is written out.
        firstName: nonEmpty(user.firstName) ?? 'Customer',
        lastName: nonEmpty(user.lastName) ?? user.email.split('@')[0] ?? 'Account',
        email: user.email,
        company: nonEmpty(formTrimmed(formData, 'company')) ?? 'Not stated',
        teamSize: nonEmpty(formTrimmed(formData, 'teamSize')),
        message,
        marketingConsent: false,
        sourcePath: PATH,
      },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    redirect(`${PATH}?notice=${status === 429 ? 'throttled' : 'failed'}`)
  }

  redirect(`${PATH}?notice=sent`)
}

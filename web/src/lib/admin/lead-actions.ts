'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { getUser } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

interface LeadResponse {
  id: string
}

/**
 * Create a lead by hand.
 *
 * The website form is not the only way an enquiry arrives — a call, a
 * conference badge, an email to someone's personal address — and a pipeline
 * that only counts the ones that came through the form measures the form, not
 * the pipeline. This posts the same fields the demo form does, to
 * `POST /v1/leads/manual`, which differs from the public route only in that it
 * authenticates, skips the bot rate limit, and does not notify admins about a
 * lead they just typed in themselves.
 *
 * On success we land on the new lead's detail page, so triage can start
 * immediately and the back button returns to the list with the row in place.
 *
 * On failure we come back to the form with `?error=`, the same channel the
 * organisation form uses. 422 is called out separately because it is the one
 * the person can act on: something they typed was not accepted, and telling
 * them "couldn't be created" would send them looking for an outage.
 */
export async function createLeadAction(formData: FormData): Promise<void> {
  await getUser()

  const body = {
    firstName: formTrimmed(formData, 'firstName'),
    lastName: formTrimmed(formData, 'lastName'),
    email: formTrimmed(formData, 'email'),
    phone: formTrimmed(formData, 'phone') || undefined,
    company: formTrimmed(formData, 'company'),
    teamSize: formTrimmed(formData, 'teamSize') || undefined,
    message: formTrimmed(formData, 'message') || undefined,
    marketingConsent: formData.get('marketingConsent') === 'on',
  }

  let id: string
  try {
    const response = await serverFetch<LeadResponse>('leads/manual', { method: 'POST', body })
    id = response.id
  } catch (err) {
    const code =
      err instanceof ApiError && (err.status === 422 || err.status === 400)
        ? 'invalid'
        : err instanceof ApiError && err.status === 403
          ? 'forbidden'
          : 'failed'
    redirect(`/app/admin/leads/new?error=${code}`)
  }

  revalidatePath('/app/admin/leads')
  redirect(`/app/admin/leads/${id}`)
}

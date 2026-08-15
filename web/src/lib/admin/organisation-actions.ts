'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { getUser } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

interface OrganisationResponse {
  id: string
}

/**
 * Create a new organisation.
 *
 * The API auto-generates the slug from the name; we do not collect a slug
 * field on the form so the two cannot drift apart. `ownerUserId` is
 * optional — leaving it blank is the path an admin takes when the customer
 * will be invited afterwards, which is the common case.
 *
 * On success, redirect to the new detail page (`/app/admin/organisations/<id>`)
 * so the freshly created record is the one the user is looking at and the
 * back button takes them to the list with the new row in place.
 *
 * On failure, redirect back to the form with `?error=<code>` so the page can
 * render an inline error banner. The page reads `params.error` and shows a
 * sentence — the same channel the login form uses (`ERROR_MESSAGES`).
 */
export async function createOrganisationAction(formData: FormData): Promise<void> {
  await getUser()

  const body = {
    name: formTrimmed(formData, 'name'),
    status: formTrimmed(formData, 'status') || 'PENDING',
    industry: formTrimmed(formData, 'industry') || undefined,
    contactEmail: formTrimmed(formData, 'contactEmail') || undefined,
    contactPhone: formTrimmed(formData, 'contactPhone') || undefined,
    website: formTrimmed(formData, 'website') || undefined,
    addressLine1: formTrimmed(formData, 'addressLine1') || undefined,
    addressLine2: formTrimmed(formData, 'addressLine2') || undefined,
    city: formTrimmed(formData, 'city') || undefined,
    state: formTrimmed(formData, 'state') || undefined,
    postalCode: formTrimmed(formData, 'postalCode') || undefined,
    countryCode: formTrimmed(formData, 'countryCode') || undefined,
    taxId: formTrimmed(formData, 'taxId') || undefined,
    notes: formTrimmed(formData, 'notes') || undefined,
    ownerUserId: formTrimmed(formData, 'ownerUserId') || undefined,
  }

  let id: string
  try {
    const response = await serverFetch<OrganisationResponse>('organisations', {
      method: 'POST',
      body,
    })
    id = response.id
  } catch (err) {
    // The page shows a generic-but-honest error banner for any non-2xx.
    // A 409 (duplicate email) is the most common failure here; the API
    // returns that as code "CONFLICT" via the standard error envelope.
    const code = err instanceof ApiError && err.status === 409 ? 'duplicate' : 'failed'
    redirect(`/app/admin/organisations/new?error=${code}`)
  }

  revalidatePath('/app/admin/organisations')
  redirect(`/app/admin/organisations/${id}`)
}

'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { getUser } from '@/lib/auth/session'
import { formString, formTrimmed } from '@/lib/form-data'

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

  const { id } = await serverFetch<OrganisationResponse>('organisations', {
    method: 'POST',
    body,
  })

  revalidatePath('/app/admin/organisations')
  redirect(`/app/admin/organisations/${id}`)
}

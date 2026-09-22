'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireCrmAccess } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formTrimmed, formString } from '@/lib/form-data'

const BASE = '/crm/leads'

/**
 * Adding a lead — the "New lead" modal on the list page. Mirrors
 * `admin/[id]/actions.ts`'s `patchEmployee`: a 4xx from the API is the
 * service declining for a stated reason ("Enter a valid 15-character
 * GSTIN"), and that sentence is the whole answer, so it is shown rather than
 * swallowed into a crash screen.
 */
export async function createLead(formData: FormData): Promise<void> {
  await requireCrmAccess()

  const body: Record<string, unknown> = {
    companyName: formTrimmed(formData, 'companyName'),
    companySize: formTrimmed(formData, 'companySize') || undefined,
    website: formTrimmed(formData, 'website') || undefined,
    industryId: formString(formData, 'industryId') || undefined,
    leadSourceId: formString(formData, 'leadSourceId') || undefined,
    countryCode: formString(formData, 'countryCode') || undefined,
    location: formTrimmed(formData, 'location') || undefined,
    registeredOrgName: formTrimmed(formData, 'registeredOrgName') || undefined,
    registeredAddress: formTrimmed(formData, 'registeredAddress') || undefined,
    gstin: formTrimmed(formData, 'gstin') || undefined,
    assignedToId: formString(formData, 'assignedToId') || undefined,
  }

  let lead: { id: string }
  try {
    lead = await hrActionFetch<{ id: string }>('hrms/crm/leads', { method: 'POST', body })
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.status >= 400 && error.status < 500) {
      redirect(`${BASE}?add=1&notice=refused&reason=${encodeURIComponent(error.message)}`)
    }
    throw error
  }

  revalidateHrms(BASE)
  redirect(`${BASE}/${lead.id}`)
}

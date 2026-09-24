'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireCrmAccess } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formTrimmed, formString } from '@/lib/form-data'

const BASE = '/crm/leads'

function detailPath(id: string, section?: string): string {
  return section ? `${BASE}/${id}?section=${section}` : `${BASE}/${id}`
}

/**
 * Every action below re-checks `requireCrmAccess` itself, even though the
 * `/crm` layout already gates the page that renders the form — a Server
 * Action is reachable on its own, the same reasoning `admin/[id]/actions.ts`
 * applies to every one of its own actions. The API's own capability
 * middleware is still the real boundary; this only gets a redirect instead
 * of a raw 403 if someone posts one of these without CRM access at all.
 */
async function leadAction<T>(
  path: string,
  options: { method: 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown> },
  id: string,
  section: string | undefined,
): Promise<T | void> {
  try {
    return await hrActionFetch<T>(path, options)
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.status === 422) redirect(`${detailPath(id, section)}&error=rejected`)
    if (error.status >= 400 && error.status < 500) {
      redirect(
        `${detailPath(id, section)}&notice=refused&reason=${encodeURIComponent(error.message)}`,
      )
    }
    throw error
  }
}

export async function updateLead(id: string, formData: FormData): Promise<void> {
  await requireCrmAccess()
  await leadAction(
    `hrms/crm/leads/${id}`,
    {
      method: 'PATCH',
      body: {
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
      },
    },
    id,
    undefined,
  )
  revalidateHrms(detailPath(id))
  redirect(detailPath(id))
}

export async function changeLeadStatus(id: string, formData: FormData): Promise<void> {
  await requireCrmAccess()
  await leadAction(
    `hrms/crm/leads/${id}/status`,
    { method: 'POST', body: { status: formString(formData, 'status') } },
    id,
    undefined,
  )
  revalidateHrms(detailPath(id))
  redirect(detailPath(id))
}

export async function assignLead(id: string, formData: FormData): Promise<void> {
  await requireCrmAccess()
  await leadAction(
    `hrms/crm/leads/${id}/assign`,
    { method: 'POST', body: { assignedToId: formString(formData, 'assignedToId') || null } },
    id,
    undefined,
  )
  revalidateHrms(detailPath(id))
  redirect(detailPath(id))
}

export async function archiveLead(id: string): Promise<void> {
  await requireCrmAccess()
  await leadAction(`hrms/crm/leads/${id}/archive`, { method: 'POST' }, id, undefined)
  revalidateHrms(BASE)
  redirect(`${BASE}?notice=archived`)
}

export async function addLeadNote(id: string, formData: FormData): Promise<void> {
  await requireCrmAccess()
  await leadAction(
    `hrms/crm/leads/${id}/activity`,
    {
      method: 'POST',
      body: {
        body: formTrimmed(formData, 'body'),
        communicationStatusId: formString(formData, 'communicationStatusId') || undefined,
      },
    },
    id,
    'activity',
  )
  revalidateHrms(detailPath(id, 'activity'))
  redirect(detailPath(id, 'activity'))
}

export async function addLeadContact(id: string, formData: FormData): Promise<void> {
  await requireCrmAccess()
  await leadAction(
    `hrms/crm/leads/${id}/contacts`,
    {
      method: 'POST',
      body: {
        name: formTrimmed(formData, 'name'),
        designation: formTrimmed(formData, 'designation') || undefined,
        phone: formTrimmed(formData, 'phone') || undefined,
        email: formTrimmed(formData, 'email') || undefined,
        profileUrl: formTrimmed(formData, 'profileUrl') || undefined,
      },
    },
    id,
    'contacts',
  )
  revalidateHrms(detailPath(id, 'contacts'))
  redirect(detailPath(id, 'contacts'))
}

export async function updateLeadContact(
  id: string,
  contactId: string,
  formData: FormData,
): Promise<void> {
  await requireCrmAccess()
  await leadAction(
    `hrms/crm/leads/${id}/contacts/${contactId}`,
    {
      method: 'PATCH',
      body: {
        name: formTrimmed(formData, 'name'),
        designation: formTrimmed(formData, 'designation') || undefined,
        phone: formTrimmed(formData, 'phone') || undefined,
        email: formTrimmed(formData, 'email') || undefined,
        profileUrl: formTrimmed(formData, 'profileUrl') || undefined,
      },
    },
    id,
    'contacts',
  )
  revalidateHrms(detailPath(id, 'contacts'))
  redirect(detailPath(id, 'contacts'))
}

export async function removeLeadContact(id: string, contactId: string): Promise<void> {
  await requireCrmAccess()
  await leadAction(
    `hrms/crm/leads/${id}/contacts/${contactId}`,
    { method: 'DELETE' },
    id,
    'contacts',
  )
  revalidateHrms(detailPath(id, 'contacts'))
  redirect(detailPath(id, 'contacts'))
}

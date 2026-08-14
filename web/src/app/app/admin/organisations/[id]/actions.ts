'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for organisation management (§2.2).
 *
 * EVERY export here must be an async function. A `const` or a `type` export
 * silently unregisters every action in a `'use server'` module, and the forms
 * then fail at runtime with an opaque error — so the shared tables and helpers
 * below stay module-private, and the notice codes are documented in the page
 * that renders them rather than exported from here.
 *
 * Each action writes through the API (the only holder of the audit log and the
 * permission gate), revalidates the list and the detail path, then redirects
 * back with a `?notice=` code. The redirect is what gives a plain
 * `<form action={…}>` feedback without a single line of client state: the page
 * re-renders from the API and reads the code out of `searchParams`.
 */

const LIST_PATH = '/app/admin/organisations'

const ORG_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']
const ORG_MEMBER_ROLES = ['OWNER', 'MEMBER']

/**
 * Profile fields whose zod rule accepts an empty string, so submitting a blank
 * input clears the stored value.
 *
 * `contactEmail` and `countryCode` are deliberately absent: their rules are
 * `.email()` and `.length(2)`, both of which reject `''`, and neither field is
 * nullable. The API therefore offers no way to clear them, so a blank input
 * leaves whatever is on file — the field hints say so.
 */
const CLEARABLE_PROFILE_FIELDS = [
  'website',
  'industry',
  'contactPhone',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'taxId',
]

function detailPath(id: string): string {
  return `${LIST_PATH}/${id}`
}

function refresh(id: string): void {
  revalidatePath(LIST_PATH)
  revalidatePath(detailPath(id))
}

/**
 * Turns a failed write into a notice code.
 *
 * `overrides` names the codes that are specific to the call site — a 409 means
 * "already a member" when adding and "last owner" when removing, and the reader
 * needs to be told which.
 */
function failureNotice(error: unknown, overrides: Record<number, string> = {}): string {
  if (error instanceof ApiError) {
    const override = overrides[error.status]
    if (override) return override
    if (error.status === 403) return 'forbidden-write'
    if (error.status === 404) return 'missing'
    if (error.status === 400 || error.status === 422) return 'invalid'
  }
  return 'failed'
}

function profileBody(formData: FormData): Record<string, string> {
  const body: Record<string, string> = {}

  const name = formTrimmed(formData, 'name')
  if (name) body.name = name

  for (const field of CLEARABLE_PROFILE_FIELDS) {
    body[field] = formTrimmed(formData, field)
  }

  const contactEmail = formTrimmed(formData, 'contactEmail')
  if (contactEmail) body.contactEmail = contactEmail

  const countryCode = formTrimmed(formData, 'countryCode')
  if (countryCode) body.countryCode = countryCode

  return body
}

/** PATCH organisations/:id — name and the profile block. */
export async function saveOrganisationProfile(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  let notice = 'profile-saved'
  try {
    await serverFetch<unknown>(`organisations/${id}`, {
      method: 'PATCH',
      body: profileBody(formData),
    })
    refresh(id)
  } catch (error) {
    notice = failureNotice(error)
  }

  redirect(`${detailPath(id)}?notice=${notice}`, 'replace')
}

/** PATCH organisations/:id — status only. */
export async function saveOrganisationStatus(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const status = formTrimmed(formData, 'status')
  let notice = 'status-saved'

  if (!ORG_STATUSES.includes(status)) {
    notice = 'invalid'
  } else {
    try {
      await serverFetch<unknown>(`organisations/${id}`, { method: 'PATCH', body: { status } })
      refresh(id)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${detailPath(id)}?notice=${notice}`, 'replace')
}

/** PATCH organisations/:id — internal notes, which only admin-side roles read. */
export async function saveOrganisationNotes(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  let notice = 'notes-saved'
  try {
    await serverFetch<unknown>(`organisations/${id}`, {
      method: 'PATCH',
      body: { notes: formTrimmed(formData, 'notes') },
    })
    refresh(id)
  } catch (error) {
    notice = failureNotice(error)
  }

  redirect(`${detailPath(id)}?notice=${notice}`, 'replace')
}

/** POST organisations/:id/members. */
export async function addOrganisationMember(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const userId = formTrimmed(formData, 'userId')
  const orgRole = formTrimmed(formData, 'orgRole')
  let notice = 'member-added'

  if (!userId) {
    notice = 'member-missing-account'
  } else if (!ORG_MEMBER_ROLES.includes(orgRole)) {
    notice = 'invalid'
  } else {
    try {
      await serverFetch<unknown>(`organisations/${id}/members`, {
        method: 'POST',
        body: { userId, orgRole },
      })
      refresh(id)
    } catch (error) {
      notice = failureNotice(error, { 400: 'member-invalid', 409: 'member-exists' })
    }
  }

  redirect(`${detailPath(id)}?notice=${notice}`, 'replace')
}

/** PATCH organisations/:id/members/:userId. */
export async function saveMemberRole(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const userId = formTrimmed(formData, 'userId')
  const orgRole = formTrimmed(formData, 'orgRole')
  let notice = 'member-role-saved'

  if (!userId || !ORG_MEMBER_ROLES.includes(orgRole)) {
    notice = 'invalid'
  } else {
    try {
      await serverFetch<unknown>(`organisations/${id}/members/${userId}`, {
        method: 'PATCH',
        body: { orgRole },
      })
      refresh(id)
    } catch (error) {
      notice = failureNotice(error, { 409: 'last-owner' })
    }
  }

  redirect(`${detailPath(id)}?notice=${notice}`, 'replace')
}

/** DELETE organisations/:id/members/:userId. */
export async function removeOrganisationMember(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const userId = formTrimmed(formData, 'userId')
  let notice = 'member-removed'

  if (!userId) {
    notice = 'invalid'
  } else {
    try {
      await serverFetch<unknown>(`organisations/${id}/members/${userId}`, { method: 'DELETE' })
      refresh(id)
    } catch (error) {
      notice = failureNotice(error, { 409: 'last-owner' })
    }
  }

  redirect(`${detailPath(id)}?notice=${notice}`, 'replace')
}

/**
 * DELETE organisations/:id — which archives rather than deletes.
 *
 * The service sets `deletedAt` and `status = ARCHIVED`; the row, its members,
 * its projects and its transactions all stay. It refuses with a 409 while the
 * organisation still has projects in flight. The button copy and the confirm
 * step below say exactly that, because "delete" here would be a lie.
 *
 * On success the detail page would 404 (every read filters `deletedAt: null`),
 * so this redirects to the list instead of back to the record.
 */
export async function archiveOrganisation(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  let failure: string | null = null

  if (formTrimmed(formData, 'confirm').toUpperCase() !== 'ARCHIVE') {
    failure = 'archive-unconfirmed'
  } else {
    try {
      await serverFetch<unknown>(`organisations/${id}`, { method: 'DELETE' })
      refresh(id)
    } catch (error) {
      failure = failureNotice(error, { 403: 'forbidden-delete', 409: 'archive-blocked' })
    }
  }

  if (failure) redirect(`${detailPath(id)}?notice=${failure}`, 'replace')
  redirect(LIST_PATH, 'replace')
}

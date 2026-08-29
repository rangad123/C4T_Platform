'use server'

import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for the customer's own organisation (§2.4).
 *
 * Mirrors `admin/organisations/[id]/actions.ts`, minus status/notes/archive —
 * a customer never touches those. The profile save hits `.../profile`, the
 * customer-only endpoint (`updateOwnOrganisationSchema`), not the bare `:id`
 * PATCH admin uses (that one requires `organisation.write`, a permission a
 * customer never holds).
 */

const DETAIL_PATH = '/app/customer/organisation'

const ORG_MEMBER_ROLES = ['OWNER', 'MEMBER']

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

/** PATCH organisations/:id/profile. */
export async function updateOrgProfileAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  let notice = 'profile-saved'
  try {
    await serverFetch<unknown>(`organisations/${id}/profile`, {
      method: 'PATCH',
      body: profileBody(formData),
    })
    revalidatePath(DETAIL_PATH)
  } catch (error) {
    notice = failureNotice(error)
  }

  redirect(`${DETAIL_PATH}?notice=${notice}`, 'replace')
}

/** POST organisations/:id/members. */
export async function addOrgMemberAction(formData: FormData): Promise<void> {
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
      revalidatePath(DETAIL_PATH)
    } catch (error) {
      notice = failureNotice(error, { 400: 'member-invalid', 409: 'member-exists' })
    }
  }

  redirect(`${DETAIL_PATH}?section=members&notice=${notice}`, 'replace')
}

/** PATCH organisations/:id/members/:userId. */
export async function updateOrgMemberAction(formData: FormData): Promise<void> {
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
      revalidatePath(DETAIL_PATH)
    } catch (error) {
      notice = failureNotice(error, { 409: 'last-owner' })
    }
  }

  redirect(`${DETAIL_PATH}?section=members&notice=${notice}`, 'replace')
}

/** DELETE organisations/:id/members/:userId. */
export async function removeOrgMemberAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  if (!id) return

  const userId = formTrimmed(formData, 'userId')
  let notice = 'member-removed'

  if (!userId) {
    notice = 'invalid'
  } else {
    try {
      await serverFetch<unknown>(`organisations/${id}/members/${userId}`, { method: 'DELETE' })
      revalidatePath(DETAIL_PATH)
    } catch (error) {
      notice = failureNotice(error, { 409: 'last-owner' })
    }
  }

  redirect(`${DETAIL_PATH}?section=members&notice=${notice}`, 'replace')
}

// ─── Team invitations (§42) ──────────────────────────────────────────────────

/**
 * Invites someone to the team by email address.
 *
 * The API owns every rule — owner-only, already-a-member, re-invite refreshes
 * rather than duplicates — so this maps its failures to codes the page turns
 * into sentences, and never forwards the API's own wording.
 */
export async function inviteTeamMemberAction(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const id = formTrimmed(formData, 'id')
  const email = formTrimmed(formData, 'email')
  if (!id) return
  if (!email) redirect(`${DETAIL_PATH}?section=members&notice=invite-email`)

  try {
    await serverFetch(`organisations/${id}/invitations`, {
      method: 'POST',
      body: {
        email,
        orgRole: formTrimmed(formData, 'orgRole') || 'MEMBER',
        message: formTrimmed(formData, 'message') || undefined,
      },
    })
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0
    const code =
      status === 409
        ? 'invite-exists'
        : status === 403
          ? 'invite-forbidden'
          : status === 422
            ? 'invite-email'
            : 'invite-failed'
    redirect(`${DETAIL_PATH}?section=members&notice=${code}`)
  }

  revalidatePath(DETAIL_PATH)
  redirect(`${DETAIL_PATH}?section=members&notice=invite-sent`)
}

/** Withdraws an invitation that has not been accepted. */
export async function revokeInvitationAction(formData: FormData): Promise<void> {
  await requireRole(['CUSTOMER'])

  const id = formTrimmed(formData, 'id')
  const invitationId = formTrimmed(formData, 'invitationId')
  if (!id || !invitationId) return

  try {
    await serverFetch(`organisations/${id}/invitations/${invitationId}`, { method: 'DELETE' })
  } catch {
    redirect(`${DETAIL_PATH}?section=members&notice=invite-failed`)
  }

  revalidatePath(DETAIL_PATH)
  redirect(`${DETAIL_PATH}?section=members&notice=invite-revoked`)
}

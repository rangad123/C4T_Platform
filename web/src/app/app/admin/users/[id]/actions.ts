'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for one user account.
 *
 * Every export here is an async function, and that is not a style choice: a
 * `'use server'` module whose exports include a type, a const or a class has
 * every action in the file silently unregistered, and the form then fails at
 * runtime with an opaque UnrecognizedActionError. Shared constants stay
 * module-private below.
 *
 * Each action re-checks its permission with `requirePermission`. Rendering the
 * form behind a permission gate is not a security boundary — an action is a POST
 * endpoint that anyone with the action id can call — so the check is repeated
 * here even though the API enforces it again on the far side.
 *
 * The API is the only thing that holds the audit log and the last-active-admin
 * guard, so nothing is validated here beyond "is this one of the enum members we
 * render". A rejected write propagates as a thrown ApiError, which is the right
 * outcome for a 409 like "this is the last active administrator": the message is
 * the API's to write, not ours to paraphrase.
 */

const LIST_PATH = '/app/admin/users'

const ROLES = ['USER', 'CUSTOMER', 'TESTER', 'ADMIN', 'SUB_ADMIN'] as const
const STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const

type RoleValue = (typeof ROLES)[number]
type StatusValue = (typeof STATUSES)[number]

function isRole(value: string): value is RoleValue {
  return (ROLES as readonly string[]).includes(value)
}

function isStatus(value: string): value is StatusValue {
  return (STATUSES as readonly string[]).includes(value)
}

function revalidateUser(id: string): void {
  revalidatePath(LIST_PATH)
  revalidatePath(`${LIST_PATH}/${id}`)
}

/**
 * PATCH users/:id over the writable profile fields.
 *
 * `firstName` and `countryCode` are omitted when blank rather than sent empty,
 * because the API's schema gives them a minimum length — an empty string is a
 * 422, not a clear. `lastName`, `phone` and `timezone` have no minimum, so an
 * empty string is a legitimate "remove this value" and is sent as one.
 */
export async function updateUserIdentity(formData: FormData): Promise<void> {
  await requirePermission('user.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  const firstName = formTrimmed(formData, 'firstName')
  const countryCode = formTrimmed(formData, 'countryCode').toUpperCase()

  await serverFetch<unknown>(`users/${id}`, {
    method: 'PATCH',
    body: {
      ...(firstName ? { firstName } : {}),
      lastName: formTrimmed(formData, 'lastName'),
      phone: formTrimmed(formData, 'phone'),
      timezone: formTrimmed(formData, 'timezone'),
      ...(countryCode.length === 2 ? { countryCode } : {}),
    },
  })

  revalidateUser(id)
}

/**
 * POST users/:id/role.
 *
 * The API does more than write a column here: moving into SUB_ADMIN seeds the
 * default grant set, and moving out of it deletes every grant. The panel copy
 * says so, because the permission editor appearing or vanishing after this
 * submit is otherwise unexplained.
 */
export async function changeUserRole(formData: FormData): Promise<void> {
  await requirePermission('user.write')

  const id = formTrimmed(formData, 'id')
  const role = formTrimmed(formData, 'role')
  if (!id || !isRole(role)) return

  await serverFetch<unknown>(`users/${id}/role`, { method: 'POST', body: { role } })

  revalidateUser(id)
}

/**
 * POST users/:id/status. Anything other than ACTIVE also revokes the account's
 * live sessions on the API side, so access stops at the target's next request.
 */
export async function changeUserStatus(formData: FormData): Promise<void> {
  await requirePermission('user.write')

  const id = formTrimmed(formData, 'id')
  const status = formTrimmed(formData, 'status')
  if (!id || !isStatus(status)) return

  const reason = formTrimmed(formData, 'reason')

  await serverFetch<unknown>(`users/${id}/status`, {
    method: 'POST',
    body: { status, ...(reason ? { reason } : {}) },
  })

  revalidateUser(id)
}

/**
 * PUT users/:id/permissions — §2.2 "Sub-Admin Permissions".
 *
 * The body is `{ permissionCodes }` and it is a full replacement set, not a
 * delta: the API deletes every grant for the user and re-creates the ones named
 * here. An unticked box is therefore a revoke, which is why the form says so
 * above the submit.
 *
 * Codes are deduplicated because the API caps the array at 60 entries and
 * counts duplicates towards that cap.
 */
export async function setSubAdminPermissions(formData: FormData): Promise<void> {
  await requirePermission('subadmin.manage')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  const permissionCodes = [
    ...new Set(
      formData
        .getAll('permissionCodes')
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ]

  await serverFetch<unknown>(`users/${id}/permissions`, {
    method: 'PUT',
    body: { permissionCodes },
  })

  revalidateUser(id)
}

/**
 * DELETE users/:id, which is a soft delete: the row keeps its history, the
 * status becomes DEACTIVATED, every session is revoked and the email address is
 * released for reuse. The button is labelled for that, not for "delete".
 *
 * Revalidation runs before the redirect, since `redirect` throws and nothing
 * after it executes.
 */
export async function archiveUserAccount(formData: FormData): Promise<void> {
  await requirePermission('user.write')

  const id = formTrimmed(formData, 'id')
  if (!id) return

  await serverFetch<unknown>(`users/${id}`, { method: 'DELETE' })

  revalidateUser(id)
  redirect(LIST_PATH)
}

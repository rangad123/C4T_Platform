'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formTrimmed, formString } from '@/lib/form-data'

const BASE = '/admin'

/**
 * Adds an employee from the four details HR types, and the API emails them an
 * invitation in the same step. There is no separate "send invitation" action:
 * adding someone is inviting them, and they choose their own password and fill
 * in the rest of their details themselves.
 *
 * A failure comes back to the open dialog with what was typed, so a mistyped
 * email means fixing one field rather than four.
 */
export async function addEmployee(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])

  const firstName = formTrimmed(formData, 'firstName')
  const lastName = formTrimmed(formData, 'lastName')
  const email = formTrimmed(formData, 'email')
  const role = formString(formData, 'role')

  const back = (error: string): string => {
    // `newRole`, not `role`: the Employees list already filters on `?role=`.
    const params = new URLSearchParams({
      add: '1',
      error,
      firstName,
      lastName,
      email,
      newRole: role,
    })
    return `${BASE}?${params.toString()}`
  }

  if (!firstName || !lastName || !email) redirect(back('missing'))

  try {
    await hrActionFetch('hrms/employees', {
      method: 'POST',
      body: { firstName, lastName, email, ...(role ? { role } : {}) },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) redirect(back('email_taken'))
    if (error instanceof ApiError && error.status === 422) redirect(back('rejected'))
    throw error
  }

  revalidateHrms(BASE)
  redirect(`${BASE}?notice=invited`)
}

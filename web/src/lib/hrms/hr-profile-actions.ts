'use server'

import { redirect } from 'next/navigation'
import { requireHrEmployee } from './hr-session'
import { hrActionFetch } from './hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formString } from '@/lib/form-data'
import { HR_ROLE_HOME } from './hr-types'

/**
 * Shared by both portals' `/profile` page — the form itself only differs in
 * where it redirects back to, which it reads from a hidden `returnTo` field
 * rather than needing two near-identical actions.
 */
export async function changeHrPassword(formData: FormData): Promise<void> {
  const employee = await requireHrEmployee()
  const returnTo = formString(formData, 'returnTo') || HR_ROLE_HOME[employee.role]
  const currentPassword = formString(formData, 'currentPassword')
  const newPassword = formString(formData, 'newPassword')
  const confirmPassword = formString(formData, 'confirmPassword')

  if (!currentPassword || !newPassword) {
    redirect(`${returnTo}?error=missing`)
  }
  if (newPassword !== confirmPassword) {
    redirect(`${returnTo}?error=mismatch`)
  }

  try {
    await hrActionFetch('hrms/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect(`${returnTo}?error=incorrect`)
    }
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
      redirect(`${returnTo}?error=rejected`)
    }
    throw error
  }

  redirect(`${returnTo}?notice=password_changed`)
}

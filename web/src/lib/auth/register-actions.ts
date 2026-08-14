'use server'

import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { ROLE_HOME, type Role } from '@/lib/api/types'
import { formString, formTrimmed } from '@/lib/form-data'
import { bridgeApiCookies } from './cookie-bridge'

/**
 * Server Action for self-registration.
 *
 * ONLY CUSTOMER AND TESTER. Those are the two things a stranger can be to this
 * platform: someone who wants testing done, and someone who wants to do it.
 * The API enforces the same restriction — this is the friendly half of a rule
 * that is real on the server (`auth.schema.ts`), not the rule itself.
 *
 * ADMIN and SUB_ADMIN accounts are created by an Admin and can never be
 * self-registered.
 */

const ALLOWED_ROLES = new Set(['CUSTOMER', 'TESTER'])

/** Field-level errors from the API, flattened for the query string. */
interface ApiValidationDetail {
  field?: string
  message?: string
}

function backToForm(params: Record<string, string | undefined>): never {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  redirect(`/register?${search.toString()}`)
}

export async function registerAction(formData: FormData): Promise<void> {
  const role = formString(formData, 'role').toUpperCase()
  const email = formTrimmed(formData, 'email')
  const firstName = formTrimmed(formData, 'firstName')
  const lastName = formTrimmed(formData, 'lastName')
  const password = formString(formData, 'password')
  const organisationName = formTrimmed(formData, 'organisationName')
  const acceptedTerms = formString(formData, 'acceptedTerms') === 'on'

  // Re-echoed on every failure path so a rejected form comes back filled in.
  const echo = {
    role: role.toLowerCase(),
    email,
    firstName,
    lastName,
    organisationName,
  }

  if (!ALLOWED_ROLES.has(role)) {
    backToForm({ ...echo, error: 'role_required' })
  }
  if (!email || !firstName || !password) {
    backToForm({ ...echo, error: 'missing' })
  }
  if (!acceptedTerms) {
    backToForm({ ...echo, error: 'terms' })
  }
  // Mirrors the API's rule so the user is told before a round trip.
  if (password.length < 12) {
    backToForm({ ...echo, error: 'password_short' })
  }
  if (role === 'CUSTOMER' && !organisationName) {
    backToForm({ ...echo, error: 'organisation_required' })
  }

  let response: Response
  try {
    response = await fetch(new URL('/v1/auth/register', env.API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        firstName,
        ...(lastName ? { lastName } : {}),
        intendedRole: role,
        ...(role === 'CUSTOMER' ? { organisationName } : {}),
        acceptedTerms: true,
      }),
      cache: 'no-store',
    })
  } catch {
    backToForm({ ...echo, error: 'network' })
  }

  if (!response.ok) {
    let code = 'failed'
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: ApiValidationDetail[] }
      }
      if (response.status === 409) code = 'email_taken'
      else if (body?.error?.code) code = body.error.code.toLowerCase()
      // A 422 carries per-field detail; surface the first one rather than a
      // generic "validation failed", which tells the user nothing actionable.
      const first = body?.error?.details?.[0]
      if (response.status === 422 && first?.message) {
        backToForm({ ...echo, error: 'field', detail: first.message })
      }
    } catch {
      // Not JSON — keep the generic code.
    }
    backToForm({ ...echo, error: code })
  }

  await bridgeApiCookies(response)

  const body = (await response.json()) as { data?: { user?: { role?: Role } } }
  const created = body?.data?.user?.role
  redirect(created ? ROLE_HOME[created] : '/app')
}

'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const PROFILE_PATH = '/app/tester/profile'

/**
 * Server Actions for the tester's own profile self-service (§2.3).
 *
 * Every action re-authorises with `requireRole(['TESTER'])` even though the
 * page that renders the form already gated on the same role — a Server
 * Action is a public POST endpoint reachable without going through the page
 * at all, so the page-level gate is a UX nicety, not the security boundary.
 *
 * `languages` has no per-item add/remove endpoint on the API — `PUT
 * /testers/me/languages` is a full-collection replace. `addLanguageAction`
 * and `removeLanguageAction` both reconstruct the intended full array from a
 * hidden JSON snapshot of the current list (carried in the form) and PUT
 * that, rather than PATCHing one row — this mirrors exactly what the API
 * contract requires, it isn't a workaround.
 */

const DEVICE_TYPES = ['MOBILE', 'TABLET', 'DESKTOP', 'SMART_TV', 'WEARABLE', 'OTHER'] as const
const PROFICIENCIES = ['NATIVE', 'FLUENT', 'PROFESSIONAL', 'BASIC'] as const

export async function updateBasicInfoAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const headline = formTrimmed(formData, 'headline')
  const bio = formTrimmed(formData, 'bio')
  const experienceYears = formTrimmed(formData, 'experienceYears')
  const city = formTrimmed(formData, 'city')
  const countryCode = formTrimmed(formData, 'countryCode')

  await serverFetch('testers/me', {
    method: 'PATCH',
    body: {
      ...(headline ? { headline } : {}),
      ...(bio ? { bio } : {}),
      ...(experienceYears ? { experienceYears: Number(experienceYears) } : {}),
      ...(city ? { city } : {}),
      ...(countryCode ? { countryCode: countryCode.toUpperCase() } : {}),
    },
  })

  revalidatePath(PROFILE_PATH)
}

export async function addDeviceAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const typeInput = formTrimmed(formData, 'type')
  const type = (DEVICE_TYPES as readonly string[]).includes(typeInput) ? typeInput : 'MOBILE'
  const manufacturer = formTrimmed(formData, 'manufacturer')
  const model = formTrimmed(formData, 'model')
  const osName = formTrimmed(formData, 'osName')
  const osVersion = formTrimmed(formData, 'osVersion')
  const network = formTrimmed(formData, 'network')
  const browser = formTrimmed(formData, 'browser')
  if (!model) return

  await serverFetch('testers/me/devices', {
    method: 'POST',
    body: {
      type,
      model,
      ...(manufacturer ? { manufacturer } : {}),
      ...(osName ? { osName } : {}),
      ...(osVersion ? { osVersion } : {}),
      ...(network ? { network } : {}),
      ...(browser ? { browser } : {}),
      isPrimary: formData.has('isPrimary'),
    },
  })

  revalidatePath(PROFILE_PATH)
}

export async function removeDeviceAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const deviceId = formTrimmed(formData, 'deviceId')
  if (!deviceId) return

  await serverFetch(`testers/me/devices/${deviceId}`, { method: 'DELETE' })
  revalidatePath(PROFILE_PATH)
}

/** Full-replacement set, matching the API's own contract for this endpoint. */
export async function setSkillsAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const raw = formTrimmed(formData, 'skills')
  const skills = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  await serverFetch('testers/me/skills', { method: 'PUT', body: { skills } })
  revalidatePath(PROFILE_PATH)
}

export async function addLanguageAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const code = formTrimmed(formData, 'code').toLowerCase()
  const proficiencyInput = formTrimmed(formData, 'proficiency')
  const proficiency = (PROFICIENCIES as readonly string[]).includes(proficiencyInput)
    ? proficiencyInput
    : 'BASIC'
  const currentJson = formTrimmed(formData, 'current')
  // `formTrimmed` always returns a string (never null/undefined), so the
  // length check alone is enough to reject a missing or malformed code.
  if (code.length !== 2) return

  let current: { code: string; proficiency: string }[] = []
  try {
    const parsed: unknown = JSON.parse(currentJson || '[]')
    if (Array.isArray(parsed)) current = parsed
  } catch {
    current = []
  }

  const next = [...current.filter((l) => l.code !== code), { code, proficiency }]

  await serverFetch('testers/me/languages', { method: 'PUT', body: { languages: next } })
  revalidatePath(PROFILE_PATH)
}

export async function removeLanguageAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const code = formTrimmed(formData, 'code')
  const currentJson = formTrimmed(formData, 'current')

  let current: { code: string; proficiency: string }[] = []
  try {
    const parsed: unknown = JSON.parse(currentJson || '[]')
    if (Array.isArray(parsed)) current = parsed
  } catch {
    current = []
  }

  const next = current.filter((l) => l.code !== code)

  await serverFetch('testers/me/languages', { method: 'PUT', body: { languages: next } })
  revalidatePath(PROFILE_PATH)
}

export async function addWorkHistoryAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const company = formTrimmed(formData, 'company')
  const jobTitle = formTrimmed(formData, 'jobTitle')
  const startDate = formTrimmed(formData, 'startDate')
  const endDate = formTrimmed(formData, 'endDate')
  const description = formTrimmed(formData, 'description')
  if (!company || !jobTitle || !startDate) return

  await serverFetch('testers/me/work-history', {
    method: 'POST',
    body: {
      company,
      jobTitle,
      startDate,
      ...(endDate ? { endDate } : {}),
      ...(description ? { description } : {}),
    },
  })

  revalidatePath(PROFILE_PATH)
}

export async function removeWorkHistoryAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const workHistoryId = formTrimmed(formData, 'workHistoryId')
  if (!workHistoryId) return

  await serverFetch(`testers/me/work-history/${workHistoryId}`, { method: 'DELETE' })
  revalidatePath(PROFILE_PATH)
}

export async function acceptNdaAction(_formData: FormData): Promise<void> {
  await requireRole(['TESTER'])
  await serverFetch('testers/me/nda', { method: 'POST', body: { accepted: true } })
  revalidatePath(PROFILE_PATH)
}

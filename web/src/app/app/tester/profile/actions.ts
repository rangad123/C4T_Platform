'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed, formStringArray } from '@/lib/form-data'

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
  const screenSize = formTrimmed(formData, 'screenSize')
  const ramGb = formTrimmed(formData, 'ramGb')
  const storageGb = formTrimmed(formData, 'storageGb')
  const network = formTrimmed(formData, 'network')
  const browser = formTrimmed(formData, 'browser')
  // Catalog picks — alongside the free text above, never instead of it. The
  // API mirrors a pick into the matching free-text field when that field was
  // left blank; see `resolveDeviceCatalogMirror` in `testers.service.ts`.
  const deviceModelId = formTrimmed(formData, 'deviceModelId')
  const osVersionRefId = formTrimmed(formData, 'osVersionRefId')
  const primaryNetworkId = formTrimmed(formData, 'primaryNetworkId')
  if (!model) return

  await serverFetch('testers/me/devices', {
    method: 'POST',
    body: {
      type,
      model,
      ...(manufacturer ? { manufacturer } : {}),
      ...(osName ? { osName } : {}),
      ...(osVersion ? { osVersion } : {}),
      ...(screenSize ? { screenSize } : {}),
      ...(ramGb ? { ramGb } : {}),
      ...(storageGb ? { storageGb } : {}),
      ...(network ? { network } : {}),
      ...(browser ? { browser } : {}),
      ...(deviceModelId ? { deviceModelId } : {}),
      ...(osVersionRefId ? { osVersionRefId } : {}),
      ...(primaryNetworkId ? { primaryNetworkId } : {}),
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

/**
 * Full-replacement set, matching the API's own contract for this endpoint.
 * Catalog ids, not free text — the checkboxes on the page carry the skill's
 * id as their `value`, so an unchecked category with zero boxes ticked
 * legitimately sends an empty array rather than the field being absent.
 */
export async function setSkillsAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const skillIds = formStringArray(formData, 'skillIds')

  await serverFetch('testers/me/skills', { method: 'PUT', body: { skillIds } })
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

const PAYMENT_COUNTRIES = ['INDIAN', 'NON_INDIAN'] as const
const PAYMENT_TYPES = ['IND_BANK_ACCOUNT', 'NON_IND_BANK_ACCOUNT', 'PAYPAL', 'PAYTM'] as const

/**
 * Full replacement, same convention as `setSkillsAction`/the language
 * actions — the API's `PUT /payment-accounts/mine` re-encrypts whatever this
 * sends as the complete sensitive-field set, so a blank field here really
 * does clear whatever was on file for it, not "leave unchanged".
 */
export async function savePaymentAccountAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const countryInput = formTrimmed(formData, 'country')
  const country = (PAYMENT_COUNTRIES as readonly string[]).includes(countryInput)
    ? countryInput
    : 'INDIAN'
  const typeInput = formTrimmed(formData, 'paymentType')
  const paymentType = (PAYMENT_TYPES as readonly string[]).includes(typeInput)
    ? typeInput
    : 'IND_BANK_ACCOUNT'

  const accountName = formTrimmed(formData, 'accountName')
  const accountNumber = formTrimmed(formData, 'accountNumber')
  const bankName = formTrimmed(formData, 'bankName')
  const branchName = formTrimmed(formData, 'branchName')
  const ifscCode = formTrimmed(formData, 'ifscCode')
  const paypalEmail = formTrimmed(formData, 'paypalEmail')
  const paytmNumber = formTrimmed(formData, 'paytmNumber')

  await serverFetch('payment-accounts/mine', {
    method: 'PUT',
    body: {
      country,
      paymentType,
      ...(accountName ? { accountName } : {}),
      ...(accountNumber ? { accountNumber } : {}),
      ...(bankName ? { bankName } : {}),
      ...(branchName ? { branchName } : {}),
      ...(ifscCode ? { ifscCode: ifscCode.toUpperCase() } : {}),
      ...(paypalEmail ? { paypalEmail } : {}),
      ...(paytmNumber ? { paytmNumber } : {}),
    },
  })

  revalidatePath(PROFILE_PATH)
}

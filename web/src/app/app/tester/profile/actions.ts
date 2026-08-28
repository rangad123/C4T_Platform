'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
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

/**
 * Saves the whole "About you" form.
 *
 * A tester's profile is split across two records: name, phone and avatar are
 * on `User` (they belong to the account, and an admin or a customer has them
 * too), while everything testing-specific is on `TesterProfile`. One form,
 * two PATCHes — the split is the API's, and hiding it behind a single save
 * button is the right call for the person filling the form in.
 *
 * Sent sequentially rather than in parallel: if the account PATCH fails
 * there is no point writing the profile half, and a partial save is easier
 * to reason about when the first half is the one that succeeded.
 *
 * Every text field is sent even when blank. The API maps `''` to null on the
 * clearable columns, which is what lets a tester actually erase a value —
 * omitting the key would silently leave the old one in place.
 */
export async function updateBasicInfoAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const firstName = formTrimmed(formData, 'firstName')
  const lastName = formTrimmed(formData, 'lastName')
  const phone = formTrimmed(formData, 'phone')

  if (firstName) {
    await serverFetch('users/me', {
      method: 'PATCH',
      body: { firstName, lastName, phone },
    })
  }

  const experienceYears = formTrimmed(formData, 'experienceYears')
  const countryCode = formTrimmed(formData, 'countryCode')

  await serverFetch('testers/me', {
    method: 'PATCH',
    body: {
      headline: formTrimmed(formData, 'headline'),
      bio: formTrimmed(formData, 'bio'),
      city: formTrimmed(formData, 'city'),
      gender: formTrimmed(formData, 'gender'),
      ageGroup: formTrimmed(formData, 'ageGroup'),
      lookingFor: formTrimmed(formData, 'lookingFor'),
      skype: formTrimmed(formData, 'skype'),
      linkedinUrl: formTrimmed(formData, 'linkedinUrl'),
      profession: formTrimmed(formData, 'profession'),
      countryCode: countryCode ? countryCode.toUpperCase() : '',
      // Numeric, so an empty box means "not stated" rather than zero — and
      // the API's schema rejects a bare '' for a number, so it is omitted
      // entirely rather than cleared.
      ...(experienceYears ? { experienceYears: Number(experienceYears) } : {}),
    },
  })

  revalidatePath(PROFILE_PATH)
}

/**
 * Attaches an already-uploaded file as the tester's signed NDA.
 *
 * The upload itself happens through the Route Handler at
 * `/app/tester/upload`; this only records the resulting file id against the
 * profile. Splitting it that way means the bytes never pass through a Server
 * Action, which has a much smaller body limit than a file upload needs.
 */
export async function setNdaDocumentAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const fileId = formTrimmed(formData, 'fileId')
  if (!fileId) return

  await serverFetch('testers/me/nda/document', { method: 'POST', body: { fileId } })
  revalidatePath(PROFILE_PATH)
}

/** Sets the account avatar from an already-uploaded file. */
export async function setAvatarAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const fileId = formTrimmed(formData, 'fileId')
  if (!fileId) return

  await serverFetch('users/me', { method: 'PATCH', body: { avatarFileId: fileId } })
  revalidatePath(PROFILE_PATH)
}

/**
 * The device body, shared by add and edit.
 *
 * `deviceSchema` on the API is the same for POST and PATCH, so building the
 * body in one place is what stops the two paths drifting — an edit that
 * silently dropped a field the create path sends would be a data-loss bug
 * that only shows up after someone edits an existing row.
 *
 * Returns null when the one genuinely required field is missing.
 */
function deviceBody(formData: FormData): Record<string, unknown> | null {
  const typeInput = formTrimmed(formData, 'type')
  const type = (DEVICE_TYPES as readonly string[]).includes(typeInput) ? typeInput : 'MOBILE'
  const model = formTrimmed(formData, 'model')
  if (!model) return null

  const manufacturer = formTrimmed(formData, 'manufacturer')
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

  return {
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
  }
}

export async function addDeviceAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const body = deviceBody(formData)
  if (!body) return

  await serverFetch('testers/me/devices', { method: 'POST', body })
  revalidatePath(PROFILE_PATH)
}

export async function updateDeviceAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const deviceId = formTrimmed(formData, 'deviceId')
  const body = deviceBody(formData)
  if (!deviceId || !body) return

  await serverFetch(`testers/me/devices/${deviceId}`, { method: 'PATCH', body })
  revalidatePath(PROFILE_PATH)
  redirect(`${PROFILE_PATH}?section=assets`)
}

export async function removeDeviceAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const deviceId = formTrimmed(formData, 'deviceId')
  if (!deviceId) return

  await serverFetch(`testers/me/devices/${deviceId}`, { method: 'DELETE' })
  revalidatePath(PROFILE_PATH)
}

// ─── Browsers ────────────────────────────────────────────────────────────────
//
// These live on the CATALOG module, not on `testers/me` — `TesterBrowser` is
// a join onto the catalog's Browser/BrowserVersion/OperatingSystem rows, so
// the endpoints sit next to the tables they reference.

/** Shared by add and edit, for the same reason `deviceBody` is. */
function browserBody(formData: FormData): Record<string, unknown> | null {
  const browserId = formTrimmed(formData, 'browserId')
  if (!browserId) return null

  const browserVersionId = formTrimmed(formData, 'browserVersionId')
  const operatingSystemId = formTrimmed(formData, 'operatingSystemId')

  return {
    browserId,
    // Explicit null, not omission: the API treats these as nullable columns,
    // and clearing a version has to actually clear it rather than leave the
    // old one in place.
    browserVersionId: browserVersionId || null,
    operatingSystemId: operatingSystemId || null,
  }
}

export async function addBrowserAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const body = browserBody(formData)
  if (!body) return

  try {
    await serverFetch('catalog/me/browsers', { method: 'POST', body })
  } catch (error) {
    // A 409 means this exact browser+version is already listed — a duplicate
    // click, not a failure worth shouting about. Anything else is real.
    if (!(error instanceof ApiError) || error.status !== 409) throw error
  }
  revalidatePath(PROFILE_PATH)
}

export async function updateBrowserAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const browserRowId = formTrimmed(formData, 'browserRowId')
  const body = browserBody(formData)
  if (!browserRowId || !body) return

  await serverFetch(`catalog/me/browsers/${browserRowId}`, { method: 'PATCH', body })
  revalidatePath(PROFILE_PATH)
  redirect(`${PROFILE_PATH}?section=assets`)
}

export async function removeBrowserAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const browserRowId = formTrimmed(formData, 'browserRowId')
  if (!browserRowId) return

  await serverFetch(`catalog/me/browsers/${browserRowId}`, { method: 'DELETE' })
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

'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed, formStringArray } from '@/lib/form-data'

const PROFILE_PATH = '/app/tester/profile'

/**
 * Turns a thrown `ApiError` into a notice code the page's `NOTICES` map
 * knows how to word. Anything else (a network drop, a bug) becomes the
 * generic `failed` — never the raw error text (§11: no stack traces, no
 * technical detail reaches this screen).
 */
function failureNotice(error: unknown, overrides: Record<number, string> = {}): string {
  if (error instanceof ApiError) {
    const override = overrides[error.status]
    if (override) return override
    if (error.status === 403) return 'forbidden'
    if (error.status === 400 || error.status === 422) return 'invalid'
  }
  return 'failed'
}

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
  const experienceYears = formTrimmed(formData, 'experienceYears')
  const countryCode = formTrimmed(formData, 'countryCode')

  let notice = 'about-saved'
  try {
    if (firstName) {
      await actionFetch('users/me', {
        method: 'PATCH',
        body: { firstName, lastName, phone },
      })
    }

    await actionFetch('testers/me', {
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
  } catch (error) {
    notice = failureNotice(error)
  }

  // No `edit=` param — this is what closes the modal. See `failureNotice`'s
  // doc comment on why a failure does not stay open with the typed values
  // echoed back: nothing here is sensitive, but the codebase does not yet
  // have that mechanism, and re-entering an aborted profile edit is a small
  // ask next to inventing a new pattern for one form.
  redirect(`${PROFILE_PATH}?section=about&notice=${notice}`)
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

  await actionFetch('testers/me/nda/document', { method: 'POST', body: { fileId } })
  revalidatePath(PROFILE_PATH)
}

/** Sets the account avatar from an already-uploaded file. */
export async function setAvatarAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const fileId = formTrimmed(formData, 'fileId')
  if (!fileId) return

  await actionFetch('users/me', { method: 'PATCH', body: { avatarFileId: fileId } })
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
  let notice = 'device-added'
  if (!body) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch('testers/me/devices', { method: 'POST', body })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${PROFILE_PATH}?section=assets&notice=${notice}`)
}

export async function updateDeviceAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const deviceId = formTrimmed(formData, 'deviceId')
  const body = deviceBody(formData)
  let notice = 'device-saved'
  if (!deviceId || !body) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch(`testers/me/devices/${deviceId}`, { method: 'PATCH', body })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${PROFILE_PATH}?section=assets&notice=${notice}`)
}

export async function removeDeviceAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const deviceId = formTrimmed(formData, 'deviceId')
  let notice = 'device-removed'
  if (!deviceId) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch(`testers/me/devices/${deviceId}`, { method: 'DELETE' })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${PROFILE_PATH}?section=assets&notice=${notice}`)
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
  let notice = 'browser-added'
  if (!body) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch('catalog/me/browsers', { method: 'POST', body })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      // A 409 means this exact browser+version is already listed — a
      // duplicate click, not a failure worth shouting about.
      if (error instanceof ApiError && error.status === 409) {
        notice = 'browser-added'
      } else {
        notice = failureNotice(error)
      }
    }
  }

  redirect(`${PROFILE_PATH}?section=assets&notice=${notice}`)
}

export async function updateBrowserAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const browserRowId = formTrimmed(formData, 'browserRowId')
  const body = browserBody(formData)
  let notice = 'browser-saved'
  if (!browserRowId || !body) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch(`catalog/me/browsers/${browserRowId}`, { method: 'PATCH', body })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${PROFILE_PATH}?section=assets&notice=${notice}`)
}

export async function removeBrowserAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const browserRowId = formTrimmed(formData, 'browserRowId')
  let notice = 'browser-removed'
  if (!browserRowId) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch(`catalog/me/browsers/${browserRowId}`, { method: 'DELETE' })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${PROFILE_PATH}?section=assets&notice=${notice}`)
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

  let notice = 'skills-saved'
  try {
    await actionFetch('testers/me/skills', { method: 'PUT', body: { skillIds } })
    revalidatePath(PROFILE_PATH)
  } catch (error) {
    notice = failureNotice(error)
  }

  redirect(`${PROFILE_PATH}?section=skills&notice=${notice}`)
}

/** Parses the hidden `current` snapshot shared by add/remove — see the doc comment above. */
function parseCurrentLanguages(formData: FormData): { code: string; proficiency: string }[] {
  const currentJson = formTrimmed(formData, 'current')
  try {
    const parsed: unknown = JSON.parse(currentJson || '[]')
    return Array.isArray(parsed) ? (parsed as { code: string; proficiency: string }[]) : []
  } catch {
    return []
  }
}

export async function addLanguageAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const code = formTrimmed(formData, 'code').toLowerCase()
  const proficiencyInput = formTrimmed(formData, 'proficiency')
  const proficiency = (PROFICIENCIES as readonly string[]).includes(proficiencyInput)
    ? proficiencyInput
    : 'BASIC'
  let notice = 'language-added'

  // `formTrimmed` always returns a string (never null/undefined), so the
  // length check alone is enough to reject a missing or malformed code —
  // the API itself rejects anything not in the ISO 639-1 list either way.
  if (code.length !== 2) {
    notice = 'invalid'
  } else {
    const current = parseCurrentLanguages(formData)
    const next = [...current.filter((l) => l.code !== code), { code, proficiency }]
    try {
      await actionFetch('testers/me/languages', { method: 'PUT', body: { languages: next } })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${PROFILE_PATH}?section=skills&notice=${notice}`)
}

export async function removeLanguageAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const code = formTrimmed(formData, 'code')
  const current = parseCurrentLanguages(formData)
  const next = current.filter((l) => l.code !== code)
  let notice = 'language-removed'

  try {
    await actionFetch('testers/me/languages', { method: 'PUT', body: { languages: next } })
    revalidatePath(PROFILE_PATH)
  } catch (error) {
    notice = failureNotice(error)
  }

  redirect(`${PROFILE_PATH}?section=skills&notice=${notice}`)
}

const WORK_HISTORY_PATH = `${PROFILE_PATH}?section=work&view=employment`

export async function addWorkHistoryAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const company = formTrimmed(formData, 'company')
  const jobTitle = formTrimmed(formData, 'jobTitle')
  const startDate = formTrimmed(formData, 'startDate')
  const endDate = formTrimmed(formData, 'endDate')
  const description = formTrimmed(formData, 'description')
  let notice = 'work-added'

  if (!company || !jobTitle || !startDate) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch('testers/me/work-history', {
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
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${WORK_HISTORY_PATH}&notice=${notice}`)
}

export async function removeWorkHistoryAction(formData: FormData): Promise<void> {
  await requireRole(['TESTER'])

  const workHistoryId = formTrimmed(formData, 'workHistoryId')
  let notice = 'work-removed'

  if (!workHistoryId) {
    notice = 'invalid'
  } else {
    try {
      await actionFetch(`testers/me/work-history/${workHistoryId}`, { method: 'DELETE' })
      revalidatePath(PROFILE_PATH)
    } catch (error) {
      notice = failureNotice(error)
    }
  }

  redirect(`${WORK_HISTORY_PATH}&notice=${notice}`)
}

export async function acceptNdaAction(_formData: FormData): Promise<void> {
  await requireRole(['TESTER'])
  await actionFetch('testers/me/nda', { method: 'POST', body: { accepted: true } })
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

  let notice = 'payment-saved'
  try {
    await actionFetch('payment-accounts/mine', {
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
  } catch (error) {
    notice = failureNotice(error)
  }

  // On failure this deliberately does NOT echo the typed fields back —
  // unlike `updateBasicInfoAction`, re-populating this form from query
  // params would put a bank account number or PayPal address in the URL,
  // server logs and browser history. The user re-enters payment details
  // from a blank form either way; nothing here was ever pre-filled with the
  // real saved values (§20).
  redirect(`${PROFILE_PATH}?section=payment&notice=${notice}`)
}

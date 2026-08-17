'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const PATH = '/app/admin/catalog'

const DEVICE_TYPES: readonly string[] = [
  'MOBILE',
  'TABLET',
  'DESKTOP',
  'SMART_TV',
  'WEARABLE',
  'OTHER',
]

/**
 * Server Actions for the device/browser catalog.
 *
 * Every one re-authorises: a Server Action is a public POST endpoint, so the
 * page's own `requireRole` is a UX gate, not the security boundary. The API
 * re-checks as well — these are three independent layers, and only the API's
 * check actually protects the data.
 *
 * A duplicate is the one failure a user will realistically hit (adding a
 * browser version that already exists), so it gets its own reason code; the
 * page renders fixed copy for it. Nothing from the API's message is echoed
 * into the URL.
 */
function reasonFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return 'duplicate'
  return 'failed'
}

async function submit(path: string, body: Record<string, unknown>): Promise<void> {
  let reason: string | null = null
  try {
    await serverFetch(path, { method: 'POST', body })
  } catch (error) {
    reason = reasonFor(error)
  }
  revalidatePath(PATH)
  redirect(reason ? `${PATH}?error=${reason}` : PATH)
}

export async function addBrandAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const name = formTrimmed(formData, 'name')
  if (!name) return
  await submit('catalog/brands', { name })
}

export async function addModelAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const brandId = formTrimmed(formData, 'brandId')
  const name = formTrimmed(formData, 'name')
  const typeInput = formTrimmed(formData, 'type')
  const defaultOsId = formTrimmed(formData, 'defaultOsId')
  const ramGb = formTrimmed(formData, 'ramGb')
  if (!brandId || !name) return

  await submit('catalog/models', {
    brandId,
    name,
    type: DEVICE_TYPES.includes(typeInput) ? typeInput : 'MOBILE',
    ...(defaultOsId ? { defaultOsId } : {}),
    ...(ramGb ? { ramGb } : {}),
  })
}

export async function addBrowserAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const name = formTrimmed(formData, 'name')
  if (!name) return
  await submit('catalog/browsers', { name })
}

export async function addBrowserVersionAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const browserId = formTrimmed(formData, 'browserId')
  const version = formTrimmed(formData, 'version')
  if (!browserId || !version) return
  await submit(`catalog/browsers/${browserId}/versions`, { version })
}

export async function addOsVersionAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const osId = formTrimmed(formData, 'osId')
  const version = formTrimmed(formData, 'version')
  if (!osId || !version) return
  await submit(`catalog/operating-systems/${osId}/versions`, { version })
}

export async function addNetworkAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])
  const name = formTrimmed(formData, 'name')
  const countryCode = formTrimmed(formData, 'countryCode')
  if (!name) return
  await submit('catalog/networks', {
    name,
    ...(countryCode ? { countryCode: countryCode.toUpperCase() } : {}),
  })
}

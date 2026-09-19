'use server'

import { revalidateHrms } from '@/lib/hrms/revalidate'
import { redirect } from 'next/navigation'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { formString, formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

const BASE = '/admin/catalogues'

/** Mirrors the API's own union; an unknown kind never reaches a fetch. */
const KINDS = ['designations', 'leave-types', 'incentive-types', 'investment-sections'] as const
type Kind = (typeof KINDS)[number]

function kindOf(formData: FormData): Kind {
  const value = formTrimmed(formData, 'kind')
  const kind = KINDS.find((k) => k === value)
  if (!kind) redirect(`${BASE}?error=unknown_kind`)
  return kind
}

function back(kind: Kind, notice: string): never {
  revalidateHrms(BASE)
  redirect(`${BASE}?kind=${kind}&notice=${notice}`)
}

function fail(kind: Kind, error: unknown): never {
  // A duplicate name is the one failure worth naming — it is what an admin
  // will actually hit, and "already exists" tells them what to do next.
  const code = error instanceof ApiError && error.status === 409 ? 'duplicate' : 'failed'
  revalidateHrms(BASE)
  redirect(`${BASE}?kind=${kind}&error=${code}`)
}

export async function createCatalogEntry(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const kind = kindOf(formData)

  const body: Record<string, unknown> = { name: formTrimmed(formData, 'name') }
  if (kind === 'investment-sections') body.code = formTrimmed(formData, 'code')
  if (kind === 'leave-types') {
    body.defaultAnnualDays = Number(formString(formData, 'defaultAnnualDays') || 0)
  }

  try {
    await hrActionFetch(`hrms/catalog/admin/${kind}`, { method: 'POST', body })
  } catch (error) {
    fail(kind, error)
  }
  back(kind, 'created')
}

export async function renameCatalogEntry(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const kind = kindOf(formData)
  const id = formTrimmed(formData, 'id')

  const body: Record<string, unknown> = { name: formTrimmed(formData, 'name') }
  if (kind === 'investment-sections') body.code = formTrimmed(formData, 'code')
  if (kind === 'leave-types') {
    body.defaultAnnualDays = Number(formString(formData, 'defaultAnnualDays') || 0)
  }

  try {
    await hrActionFetch(`hrms/catalog/admin/${kind}/${id}`, { method: 'PATCH', body })
  } catch (error) {
    fail(kind, error)
  }
  back(kind, 'saved')
}

/**
 * Retire or restore. There is no delete: employee records and leave requests
 * point at these rows, so removing one would either fail on a foreign key or
 * orphan history. Retiring takes it out of every picker and leaves what
 * already references it alone.
 */
export async function setCatalogEntryActive(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const kind = kindOf(formData)
  const id = formTrimmed(formData, 'id')
  const isActive = formString(formData, 'isActive') === 'true'

  try {
    await hrActionFetch(`hrms/catalog/admin/${kind}/${id}`, {
      method: 'PATCH',
      body: { isActive },
    })
  } catch (error) {
    fail(kind, error)
  }
  back(kind, isActive ? 'restored' : 'retired')
}

'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireCrmCapability } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { formTrimmed } from '@/lib/form-data'
import { ApiError } from '@/lib/api/types'

const BASE = '/crm/catalog'

/** Mirrors the API's own union for this route — see hr-catalog.schema.ts's `crmCatalogKindParam`. */
const KINDS = ['crm-industries', 'crm-lead-sources', 'crm-communication-statuses'] as const
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
  const code = error instanceof ApiError && error.status === 409 ? 'duplicate' : 'failed'
  revalidateHrms(BASE)
  redirect(`${BASE}?kind=${kind}&error=${code}`)
}

export async function createCrmCatalogEntry(formData: FormData): Promise<void> {
  await requireCrmCapability('manage_catalog')
  const kind = kindOf(formData)

  try {
    await hrActionFetch(`hrms/catalog/crm/${kind}`, {
      method: 'POST',
      body: { name: formTrimmed(formData, 'name') },
    })
  } catch (error) {
    fail(kind, error)
  }
  back(kind, 'created')
}

export async function setCrmCatalogEntryActive(formData: FormData): Promise<void> {
  await requireCrmCapability('manage_catalog')
  const kind = kindOf(formData)
  const id = formTrimmed(formData, 'id')
  const isActive = formTrimmed(formData, 'isActive') === 'true'

  try {
    await hrActionFetch(`hrms/catalog/crm/${kind}/${id}`, { method: 'PATCH', body: { isActive } })
  } catch (error) {
    fail(kind, error)
  }
  back(kind, isActive ? 'restored' : 'retired')
}

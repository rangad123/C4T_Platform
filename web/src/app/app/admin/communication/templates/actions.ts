'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { serverFetch } from '@/lib/api/server'
import { ApiError } from '@/lib/api/types'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const LIST_PATH = '/app/admin/communication/templates'

/** Maps an API failure to one of the page's known reason codes. */
function reasonFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) return 'duplicate'
  return 'failed'
}

export async function createTemplateAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const name = formTrimmed(formData, 'name')
  const subject = formTrimmed(formData, 'subject')
  const body = formTrimmed(formData, 'body')
  if (!name || !body) return

  let reason: string | null = null
  try {
    await serverFetch('communication/templates', {
      method: 'POST',
      body: { name, ...(subject ? { subject } : {}), body },
    })
  } catch (error) {
    reason = reasonFor(error)
  }

  revalidatePath(LIST_PATH)
  redirect(reason ? `${LIST_PATH}?error=${reason}` : LIST_PATH)
}

export async function deleteTemplateAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const id = formTrimmed(formData, 'id')
  if (!id) return

  await serverFetch(`communication/templates/${id}`, { method: 'DELETE' })
  revalidatePath(LIST_PATH)
}

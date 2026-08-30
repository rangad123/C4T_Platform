'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const SETTINGS_PATH = '/app/admin/settings'

/**
 * Publishes an already-uploaded PDF as the blank NDA testers download.
 *
 * The bytes went through `/app/admin/upload`; only the resulting id passes
 * through here. The API re-checks that the file exists and was uploaded under
 * the platform-document scope — this action is not what makes that safe.
 */
export async function setNdaTemplateAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const fileId = formTrimmed(formData, 'fileId')
  if (!fileId) return

  try {
    await actionFetch('settings/nda-template', { method: 'PUT', body: { fileId } })
  } catch {
    redirect(`${SETTINGS_PATH}?notice=nda-failed`)
  }

  revalidatePath(SETTINGS_PATH)
  redirect(`${SETTINGS_PATH}?notice=nda-saved`)
}

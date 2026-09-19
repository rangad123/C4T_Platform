'use server'

import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'

const BASE = '/admin/templates'

/**
 * Bound to `SingleFileUpload`'s `onUploaded`, which only ever hands back the
 * uploaded file's id — there is no sibling "name" field in that flow. The
 * API defaults the template's name to the file's own name when none is
 * given (see hr-templates.service.ts), so a plain upload needs nothing else.
 */
export async function createTemplate(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const fileId = formData.get('fileId')
  if (typeof fileId !== 'string' || !fileId) return

  await hrActionFetch('hrms/templates', { method: 'POST', body: { fileId } })
  revalidateHrms(BASE)
}

export async function deleteTemplate(id: string): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/templates/${id}`, { method: 'DELETE' })
  revalidateHrms(BASE)
}

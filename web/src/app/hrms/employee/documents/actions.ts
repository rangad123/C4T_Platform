'use server'

import { redirect } from 'next/navigation'
import { revalidateHrms } from '@/lib/hrms/revalidate'
import { requireHrEmployee } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'

const BASE = '/employee/documents'

function documentsPath(message?: string): string {
  return message ? `${BASE}?docError=${encodeURIComponent(message)}` : BASE
}

/**
 * Attaches an already-uploaded file to the signed-in employee's own record.
 * Mirrors `admin/[id]/actions.ts`'s `addEmployeeDocument` — same two-step
 * shape (the file is already stored; this just links it) — but `kind` is
 * bound from a fixed 3-value list the page offers, and the target is always
 * the caller's own id via `hrms/me/documents`, never a param from the page.
 */
export async function addOwnDocument(kind: string, formData: FormData): Promise<void> {
  await requireHrEmployee()
  const fileId = formData.get('fileId')
  if (typeof fileId !== 'string' || !fileId) return
  try {
    await hrActionFetch('hrms/me/documents', { method: 'POST', body: { kind, fileId } })
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      redirect(documentsPath(error.message))
    }
    throw error
  }
  revalidateHrms(BASE)
}

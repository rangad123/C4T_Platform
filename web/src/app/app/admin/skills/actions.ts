'use server'

import { revalidatePath } from 'next/cache'
import { serverFetch } from '@/lib/api/server'
import { requireRole } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

const LIST_PATH = '/app/admin/skills'

const CATEGORIES = ['DOMAIN', 'TYPE', 'TOOL', 'APPLICATION'] as const

/**
 * Server Action: re-classify a skill.
 *
 * Mirrors the API's `setSkillCategorySchema` — only the four enum values are
 * accepted, anything else is narrowed to TOOL here rather than trusted to
 * the API to default it.
 */
export async function setSkillCategoryAction(formData: FormData): Promise<void> {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const skillId = formTrimmed(formData, 'skillId')
  const categoryInput = formTrimmed(formData, 'category')
  if (!skillId) return

  const category = (CATEGORIES as readonly string[]).includes(categoryInput)
    ? categoryInput
    : 'TOOL'

  await serverFetch(`testers/skills/${skillId}/category`, {
    method: 'PATCH',
    body: { category },
  })

  revalidatePath(LIST_PATH)
}

'use server'

import { redirect } from 'next/navigation'
import { revalidatePath, updateTag } from 'next/cache'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError } from '@/lib/api/types'
import { formTrimmed } from '@/lib/form-data'

const BASE = '/app/admin/blog/categories'

interface CategoryResponse {
  id: string
}

export async function createCategoryAction(formData: FormData): Promise<void> {
  const body = {
    name: formTrimmed(formData, 'name'),
    description: formTrimmed(formData, 'description') || undefined,
  }

  try {
    await actionFetch<CategoryResponse>('blog/categories', { method: 'POST', body })
  } catch (err) {
    const code = err instanceof ApiError && err.status === 409 ? 'duplicate' : 'failed'
    redirect(`${BASE}?new=1&error=${code}&name=${encodeURIComponent(body.name)}`)
  }

  revalidatePath(BASE)
  updateTag('blog-categories')
  redirect(`${BASE}?notice=created`)
}

export async function updateCategoryAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const body = {
    name: formTrimmed(formData, 'name') || undefined,
    description: formTrimmed(formData, 'description') || undefined,
  }

  try {
    await actionFetch<CategoryResponse>(`blog/categories/${id}`, { method: 'PATCH', body })
  } catch (err) {
    const code = err instanceof ApiError && err.status === 409 ? 'duplicate' : 'failed'
    redirect(`${BASE}?edit=${id}&error=${code}`)
  }

  revalidatePath(BASE)
  updateTag('blog-categories')
  redirect(`${BASE}?notice=updated`)
}

export async function toggleCategoryActiveAction(formData: FormData): Promise<void> {
  const id = formTrimmed(formData, 'id')
  const isActive = formTrimmed(formData, 'isActive') === 'true'

  try {
    await actionFetch<CategoryResponse>(`blog/categories/${id}`, {
      method: 'PATCH',
      body: { isActive },
    })
  } catch {
    redirect(`${BASE}?error=failed`)
  }

  revalidatePath(BASE)
  updateTag('blog-categories')
  redirect(`${BASE}?notice=${isActive ? 'reactivated' : 'retired'}`)
}

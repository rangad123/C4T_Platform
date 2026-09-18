'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireHrRole } from '@/lib/hrms/hr-session'
import { hrActionFetch } from '@/lib/hrms/hr-action-fetch'
import { ApiError } from '@/lib/api/types'
import { formString } from '@/lib/form-data'

const BASE = '/admin/holidays'

export async function addHoliday(formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  const date = formString(formData, 'date')
  const year = date.slice(0, 4)
  try {
    await hrActionFetch('hrms/holidays', {
      method: 'POST',
      body: { date, name: formString(formData, 'name') },
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      redirect(`${BASE}?year=${year}&error=duplicate`)
    }
    throw error
  }
  revalidatePath(BASE)
  revalidatePath('/employee/holidays')
  redirect(`${BASE}?year=${year}`)
}

export async function deleteHoliday(id: string, formData: FormData): Promise<void> {
  await requireHrRole(['ADMIN'])
  await hrActionFetch(`hrms/holidays/${id}`, { method: 'DELETE' })
  revalidatePath(BASE)
  revalidatePath('/employee/holidays')
  redirect(`${BASE}?year=${formString(formData, 'year')}`)
}

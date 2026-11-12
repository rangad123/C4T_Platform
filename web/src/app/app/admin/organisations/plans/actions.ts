'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError, type ValidationDetail } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for plan definitions. Every export is an async function (a
 * `'use server'` rule). API refusals come back as their own message in `?error=`.
 */

const BASE = '/app/admin/organisations/plans'

function toMinor(input: string): string | null {
  const cleaned = input.replace(/[\s,]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, fraction = ''] = cleaned.split('.')
  const minor = `${whole}${`${fraction}00`.slice(0, 2)}`.replace(/^0+(?=\d)/, '')
  return minor.length > 15 ? null : minor
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const first = Array.isArray(error.details)
      ? (error.details[0] as Partial<ValidationDetail> | undefined)
      : undefined
    return (first?.message ?? error.message).slice(0, 240)
  }
  return 'The plans service is unreachable. Try again in a moment.'
}

async function run(notice: string, call: () => Promise<unknown>): Promise<never> {
  let error: string | null = null
  try {
    await call()
  } catch (e) {
    error = messageOf(e)
  }
  revalidatePath(BASE)
  redirect(error ? `${BASE}?error=${encodeURIComponent(error)}` : `${BASE}?notice=${notice}`)
}

export async function createPlan(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')
  const price = formTrimmed(formData, 'price')
  const priceMinor = price ? toMinor(price) : null
  if (price && priceMinor === null) {
    redirect(
      `${BASE}?error=${encodeURIComponent('Enter the price as an amount, or leave it blank.')}`,
    )
  }
  const description = formTrimmed(formData, 'description')
  const projects = formTrimmed(formData, 'projectsIncluded')
  const testers = formTrimmed(formData, 'privateTestersIncluded')
  await run('created', () =>
    actionFetch('org-finance/plans', {
      method: 'POST',
      body: {
        name: formTrimmed(formData, 'name'),
        currency: formTrimmed(formData, 'currency') || 'INR',
        ...(description ? { description: description.slice(0, 1000) } : {}),
        ...(priceMinor ? { priceMinor } : {}),
        ...(projects ? { projectsIncluded: projects } : {}),
        ...(testers ? { privateTestersIncluded: testers } : {}),
      },
    }),
  )
}

export async function setPlanArchived(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')
  const archived = formTrimmed(formData, 'archived') === 'true'
  await run(archived ? 'archived' : 'restored', () =>
    actionFetch(`org-finance/plans/${formTrimmed(formData, 'planId')}`, {
      method: 'PATCH',
      body: { archived },
    }),
  )
}

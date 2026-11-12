'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { actionFetch } from '@/lib/api/action-fetch'
import { ApiError, type ValidationDetail } from '@/lib/api/types'
import { requirePermission } from '@/lib/auth/session'
import { formTrimmed } from '@/lib/form-data'

/**
 * Server Actions for an organisation's wallet: top-up, lock and release per
 * build, the per-build tester reward, and the organisation's plan.
 *
 * EVERY export here is an async function (a `'use server'` module with any
 * other export silently unregisters its actions). The API holds the money
 * rules and the `transaction.write` gate; the permission is re-checked here
 * because a Server Action is a public POST endpoint.
 *
 * A refusal from the API comes back as its own message in `?error=`, so the
 * admin reads "That is more than the organisation has in its wallet" rather
 * than a crash screen. A retried submit carries the same `key` the form was
 * rendered with, so the API records the move once.
 */

function walletPath(orgId: string): string {
  return `/app/admin/organisations/${orgId}/wallet`
}

/** Major units → minor units by string surgery (no float). Null when not a positive amount. */
function toMinor(input: string, allowZero = false): string | null {
  const cleaned = input.replace(/[\s,]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, fraction = ''] = cleaned.split('.')
  const minor = `${whole}${`${fraction}00`.slice(0, 2)}`.replace(/^0+(?=\d)/, '')
  if (minor.length > 15) return null
  if (!allowZero && /^0+$/.test(minor)) return null
  return minor
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const first = Array.isArray(error.details)
      ? (error.details[0] as Partial<ValidationDetail> | undefined)
      : undefined
    return (first?.message ?? error.message).slice(0, 240)
  }
  return 'The wallet service is unreachable. Try again in a moment.'
}

async function run(orgId: string, notice: string, call: () => Promise<unknown>): Promise<never> {
  let error: string | null = null
  try {
    await call()
  } catch (e) {
    error = messageOf(e)
  }
  revalidatePath(walletPath(orgId))
  redirect(
    error
      ? `${walletPath(orgId)}?error=${encodeURIComponent(error)}`
      : `${walletPath(orgId)}?notice=${notice}`,
  )
}

function back(orgId: string, error: string): never {
  redirect(`${walletPath(orgId)}?error=${encodeURIComponent(error)}`)
}

export async function recordTopUp(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')
  const orgId = formTrimmed(formData, 'orgId')
  const amountMinor = toMinor(formTrimmed(formData, 'amount'))
  if (!amountMinor) back(orgId, 'Enter an amount greater than zero, with at most two decimals.')
  const occurredAt = formTrimmed(formData, 'occurredAt')
  const externalRef = formTrimmed(formData, 'externalRef').slice(0, 120)
  const description = formTrimmed(formData, 'description').slice(0, 1000)
  await run(orgId, 'topped-up', () =>
    actionFetch(`org-finance/organisations/${orgId}/top-ups`, {
      method: 'POST',
      body: {
        amountMinor,
        currency: formTrimmed(formData, 'currency') || 'INR',
        key: formTrimmed(formData, 'key'),
        ...(occurredAt ? { occurredAt } : {}),
        ...(externalRef ? { externalRef } : {}),
        ...(description ? { description } : {}),
      },
    }),
  )
}

export async function lockBuildFunds(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')
  const orgId = formTrimmed(formData, 'orgId')
  const amountMinor = toMinor(formTrimmed(formData, 'amount'))
  if (!amountMinor) back(orgId, 'Enter an amount to lock greater than zero.')
  await run(orgId, 'locked', () =>
    actionFetch(`org-finance/builds/${formTrimmed(formData, 'buildId')}/lock`, {
      method: 'POST',
      body: { amountMinor, key: formTrimmed(formData, 'key') },
    }),
  )
}

export async function releaseBuildFunds(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')
  const orgId = formTrimmed(formData, 'orgId')
  await run(orgId, 'released', () =>
    actionFetch(`org-finance/builds/${formTrimmed(formData, 'buildId')}/release`, {
      method: 'POST',
    }),
  )
}

export async function saveBuildReward(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')
  const orgId = formTrimmed(formData, 'orgId')
  const raw = formTrimmed(formData, 'reward')
  const testerRewardMinor = raw ? toMinor(raw, true) : null
  if (raw && testerRewardMinor === null)
    back(orgId, 'Enter the reward as an amount, or leave it blank.')
  await run(orgId, 'reward-saved', () =>
    actionFetch(`org-finance/builds/${formTrimmed(formData, 'buildId')}/reward`, {
      method: 'PUT',
      body: { testerRewardMinor, rewardsCurrency: formTrimmed(formData, 'currency') || 'INR' },
    }),
  )
}

export async function assignOrganisationPlan(formData: FormData): Promise<void> {
  await requirePermission('transaction.write')
  const orgId = formTrimmed(formData, 'orgId')
  const startDate = formTrimmed(formData, 'startDate')
  const endDate = formTrimmed(formData, 'endDate')
  const projects = formTrimmed(formData, 'remainingProjects')
  const testers = formTrimmed(formData, 'remainingPrivateTesters')
  if (!formTrimmed(formData, 'planId') || !startDate)
    back(orgId, 'Choose a plan and its start date.')
  await run(orgId, 'plan-assigned', () =>
    actionFetch(`org-finance/organisations/${orgId}/plans`, {
      method: 'POST',
      body: {
        planId: formTrimmed(formData, 'planId'),
        startDate,
        ...(endDate ? { endDate } : {}),
        ...(projects ? { remainingProjects: projects } : {}),
        ...(testers ? { remainingPrivateTesters: testers } : {}),
      },
    }),
  )
}

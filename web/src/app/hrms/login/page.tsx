import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getHrEmployee } from '@/lib/hrms/hr-session'
import { HR_ROLE_HOME } from '@/lib/hrms/hr-types'
import { safeNextOrHome } from '@/lib/safe-redirect'
import HrLoginForm from './form'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

/**
 * The HRMS sign-in screen. Reached as `/login` on `hrms.crowd4test.com` (the
 * `/hrms` prefix is an internal rewrite, invisible in the address bar — see
 * `proxy.ts`'s `hrmsRewrite`).
 *
 * No intercepted-route dialog here unlike the platform's `/login`: HRMS has
 * no marketing site to sit over, every arrival is a hard load.
 */
export default async function HrLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string }>
}) {
  const params = await searchParams

  const employee = await getHrEmployee()
  if (employee) redirect(safeNextOrHome(params.next, HR_ROLE_HOME[employee.role]))

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-6)',
        background: 'var(--surface-sunken)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          padding: 'var(--space-8)',
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-panel)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <HrLoginForm searchParams={Promise.resolve(params)} />
      </div>
    </div>
  )
}

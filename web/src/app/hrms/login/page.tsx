import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getHrEmployee } from '@/lib/hrms/hr-session'
import { HR_ROLE_HOME } from '@/lib/hrms/hr-types'
import { safeNextOrHome } from '@/lib/safe-redirect'
import HrLoginForm from './form'
import styles from './login.module.css'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

/** Enough tiles to cover any window size once the grid is rotated and overscanned. */
const WATERMARK_TILES = 48

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
  searchParams: Promise<{ next?: string; notice?: string }>
}) {
  const params = await searchParams

  const employee = await getHrEmployee()
  if (employee) redirect(safeNextOrHome(params.next, HR_ROLE_HOME[employee.role]))

  return (
    <div className={styles.page}>
      {/* Decorative — a real screen reader user gets nothing from "Crowd4Test"
          repeated 48 times, so it is hidden rather than announced. */}
      <div className={styles.watermark} aria-hidden="true">
        {Array.from({ length: WATERMARK_TILES }, (_, i) => (
          <span key={i} className={styles.watermarkWord}>
            Crowd<span className={styles.watermarkAccent}>4</span>Test
          </span>
        ))}
      </div>
      <div className={styles.card}>
        <HrLoginForm next={params.next} notice={params.notice} />
      </div>
    </div>
  )
}

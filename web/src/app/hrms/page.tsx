import { redirect } from 'next/navigation'
import { requireHrEmployee } from '@/lib/hrms/hr-session'
import { HR_ROLE_HOME } from '@/lib/hrms/hr-types'

/** hrms.crowd4test.com's bare root — sends a visitor to /login or straight to their own portal. */
export default async function HrRootPage() {
  const employee = await requireHrEmployee()
  redirect(HR_ROLE_HOME[employee.role])
}

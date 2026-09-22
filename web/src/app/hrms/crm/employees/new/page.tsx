import { redirect } from 'next/navigation'
import { requireCrmCapability } from '@/lib/hrms/hr-session'

/**
 * "Add Employee" from CRM. It does not duplicate the existing HRMS
 * add-employee flow — it deep-links to it. `requireCrmCapability` already
 * confirms the visitor holds `add_employee` (which, per
 * `canAddEmployeeFromCrm`'s own reasoning, only ever true for someone who is
 * ALSO `HrRole.ADMIN`), so `/admin?add=1` is guaranteed to open for them.
 */
export default async function HrCrmAddEmployeePage() {
  await requireCrmCapability('add_employee')
  redirect('/admin?add=1')
}

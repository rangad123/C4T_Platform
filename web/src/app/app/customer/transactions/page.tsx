import { requireRole } from '@/lib/auth/session'
import { Topbar } from '@/components/admin/Topbar'
import { AdminSectionNotReady } from '@/components/admin/AdminSectionNotReady'

const ROOT = { label: 'Customer', href: '/app/customer' }

/**
 * `/app/customer/transactions` — linked from the sidebar, not built yet.
 * `GET /transactions` is already scoped to "my organisation" server-side
 * (`transactionScope` in scopes.ts) — this is a UI gap, not a backend one.
 * See `customer/page.tsx`'s own comment for why the Dashboard doesn't show
 * a financial KPI yet: `/transactions/summary/mine` is a tester-earnings
 * aggregate, wrong for a customer, so this page needs its own read of the
 * plain `/transactions` list rather than reusing that endpoint.
 */
export default async function CustomerTransactionsPage() {
  await requireRole(['CUSTOMER'])

  return (
    <>
      <Topbar root={ROOT} crumbs={[{ label: 'Transactions' }]} />
      <AdminSectionNotReady
        section="Operations"
        icon="credit-card"
        homeHref="/app/customer"
        description="A read-only record of your organisation's invoices and payments."
      />
    </>
  )
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
/**
 * The customer side's CSV export proxy.
 *
 * Same handler the admin side uses. It forwards the session cookie and streams
 * whatever the API returns — authorization is entirely the API's (`report.generate`
 * resolves through `projectRelations`, so a customer only ever reaches their own
 * organisation's projects). This route exists per-portal only so the link in the
 * UI is same-origin and sits under the portal's own path.
 */
export { GET } from '@/lib/api/csv-proxy'

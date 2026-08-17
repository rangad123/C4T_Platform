import { SectionTabs, type SectionTab } from '@/components/admin/SectionTabs'

/**
 * Sub-navigation for Assets — what the tester population actually owns.
 *
 * Two routes rather than one page with a query param: each list has its own
 * filters and its own pagination, and loading both to render one of them is
 * work nobody asked for. The catalog next door is the other half of this —
 * catalog is the reference data we maintain, assets is what testers reported
 * against it.
 */
const TABS: readonly SectionTab[] = [
  { value: 'devices', label: 'Devices', icon: 'smartphone', href: '/app/admin/assets/devices' },
  { value: 'browsers', label: 'Browsers', icon: 'monitor', href: '/app/admin/assets/browsers' },
]

export function AssetsTabs({ active }: { active: string }) {
  return <SectionTabs basePath="/app/admin/assets/devices" tabs={TABS} active={active} />
}

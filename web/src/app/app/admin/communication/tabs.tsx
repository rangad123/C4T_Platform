import { SectionTabs, type SectionTab } from '@/components/admin/SectionTabs'

/**
 * Sub-navigation shared by every Communication page.
 *
 * These sections are separate ROUTES, not panels of one page — each loads its
 * own data (a tester roster, an announcement list, a thread list, a template
 * list), and folding them into one page would mean fetching all four to render
 * whichever one you actually wanted. So the tabs link, and each tab passes its
 * own `active` value.
 *
 * Compose is first and is the module's landing page: the reason to open
 * Communication is almost always to say something, and the previous landing —
 * a list of past announcements — put the archive in front of the action.
 */
const TABS: readonly SectionTab[] = [
  { value: 'compose', label: 'Compose', icon: 'message-square', href: '/app/admin/communication' },
  {
    value: 'announcements',
    label: 'Announcements',
    icon: 'radio-tower',
    href: '/app/admin/communication/announcements',
  },
  {
    value: 'threads',
    label: 'Threads',
    icon: 'users',
    href: '/app/admin/communication/threads',
  },
  {
    value: 'templates',
    label: 'Templates',
    icon: 'file-text',
    href: '/app/admin/communication/templates',
  },
]

export function CommunicationTabs({ active }: { active: string }) {
  return <SectionTabs basePath="/app/admin/communication" tabs={TABS} active={active} />
}

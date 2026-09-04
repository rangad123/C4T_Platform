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
 * Messages is first and is the module's landing page. It used to be the
 * composer itself, which meant Communication opened on a form and there was
 * no way to look at anything already sent — because nothing recorded a send.
 * Now the archive is the landing and composing is a route off it, reached by
 * the "New message" button rather than by a tab: a three-step task is not a
 * peer of three lists.
 */
const TABS: readonly SectionTab[] = [
  { value: 'messages', label: 'Messages', icon: 'message-square', href: '/app/admin/communication' },
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

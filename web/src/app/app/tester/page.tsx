import { PortalNotReady } from '@/components/portal/PortalNotReady'

/**
 * `/app/tester` — the tester home, currently the same placeholder as
 * `/app`. The route exists so the URL a tester is sent to after sign-in
 * resolves to something rather than a 404, and so the persona map in
 * `ROLE_HOME` maps to a real page.
 *
 * The tester portal is the next one to be built — when it is, this file
 * becomes the dashboard and the placeholder component is deleted.
 */
export default function TesterHomePage() {
  return <PortalNotReady />
}

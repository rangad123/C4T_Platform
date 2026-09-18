import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: { default: 'Crowd4Test HRMS', template: '%s — Crowd4Test HRMS' },
  robots: { index: false, follow: false },
}

/**
 * The whole HRMS tree hangs off this segment. It nests under the app's one
 * real `<html>`/`<body>` shell in `app/layout.tsx` like every other route —
 * `/hrms` is a normal directory, not a route group, so there is no second
 * root layout here, just the metadata every page under it should inherit.
 */
export default function HrmsLayout({ children }: { children: React.ReactNode }) {
  return children
}

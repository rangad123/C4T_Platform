'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { HR_LIST_VIEW_COOKIE, type HrListView } from './list-view'

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

/**
 * Remembers the chosen view and returns to the list.
 *
 * A Server Action rather than a plain link because a link cannot set a cookie,
 * and without one the choice is forgotten between visits — which for someone
 * who asked for the card layout back is the same as not having it.
 *
 * `returnTo` is the caller's current URL, passed through so filters, sort and
 * page survive the switch. It is validated as a path on this site: it comes
 * from a form field, and a form field that becomes a redirect target is an
 * open redirect unless it is checked.
 */
export async function setHrListView(formData: FormData): Promise<void> {
  const view: HrListView = formData.get('view') === 'cards' ? 'cards' : 'table'
  const requested = formData.get('returnTo')
  const returnTo =
    typeof requested === 'string' && requested.startsWith('/') && !requested.startsWith('//')
      ? requested
      : '/admin'

  const store = await cookies()
  store.set({
    name: HR_LIST_VIEW_COOKIE,
    value: view,
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    sameSite: 'lax',
    // Not `httpOnly`: it holds a layout preference, nothing a script reading
    // it could do harm with, and leaving it readable means a future client
    // component can match it without a round trip.
    httpOnly: false,
  })

  redirect(returnTo)
}

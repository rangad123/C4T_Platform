import { cookies } from 'next/headers'

/**
 * How the Employees list is drawn.
 *
 * The old HR system's landing page was a grid of staff cards — photo, name,
 * designation, contact. The rebuild used a table, which is better for finding
 * one person among forty-six and worse for recognising a face. Rather than
 * pick a winner, both are offered.
 */
export type HrListView = 'table' | 'cards'

export const HR_LIST_VIEW_COOKIE = 'hrms_list_view'

/**
 * Resolves the view: the URL wins, then the remembered choice, then table.
 *
 * Remembered in a cookie rather than `localStorage` because the list is a
 * Server Component — a preference the server cannot read would mean rendering
 * a table and swapping it client-side on every load, which is a visible
 * flicker for something the reader already decided.
 *
 * The URL still overrides, so a link to a particular view keeps working for
 * whoever opens it.
 */
export async function resolveListView(param: string | undefined): Promise<HrListView> {
  if (param === 'cards' || param === 'table') return param
  const stored = (await cookies()).get(HR_LIST_VIEW_COOKIE)?.value
  return stored === 'cards' ? 'cards' : 'table'
}

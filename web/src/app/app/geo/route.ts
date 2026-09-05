import { NextResponse } from 'next/server'
import { getUser } from '@/lib/auth/session'
import { cityOptions, stateOptions } from '@/lib/geo/source'

export const dynamic = 'force-dynamic'

/**
 * `/app/geo` — states and cities for the dependent location picker.
 *
 * ── WHY A ROUTE AND NOT A PROP
 *
 * `LocationSelect` has to react to a country changing without navigating: it
 * lives inside edit forms, and re-rendering the page on every country change
 * would throw away whatever else the reader had typed. So it needs the data
 * client-side — but the data comes from `country-state-city`, which is ~17MB
 * and must never reach a browser bundle. This route is the seam: the package
 * stays on the server, the browser gets the fifty rows it asked for.
 *
 * ── WHAT IT DOES NOT NEED PROTECTING FROM
 *
 * The response is a list of place names. It is not personal, not tenant
 * scoped, and identical for every caller — the same content any atlas has.
 * The session check is here only so the route is not an open endpoint for
 * anonymous traffic to hammer; there is nothing to leak by being signed in.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const params = new URL(request.url).searchParams
  const country = (params.get('country') ?? '').trim().toUpperCase()
  const state = (params.get('state') ?? '').trim().toUpperCase()

  if (!country) return NextResponse.json({ error: 'country required' }, { status: 400 })

  /*
    One route, two shapes, chosen by whether a state was named. Cities without
    a state would be every city in the country — tens of thousands of rows,
    and a picker nobody can use.
  */
  if (state) {
    return NextResponse.json({ options: cityOptions(country, state) })
  }
  return NextResponse.json({ options: stateOptions(country) })
}

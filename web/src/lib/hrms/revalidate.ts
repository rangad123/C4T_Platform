import { revalidatePath } from 'next/cache'

/**
 * Invalidate an HRMS page, named by the path the BROWSER uses.
 *
 * ── WHY THIS EXISTS
 *
 * HRMS is served from its own hostname, and `hrmsRewrite` in `proxy.ts`
 * rewrites every request on it to `/hrms` + the path. So one page has two
 * names: `/admin/<id>` is what the address bar and every `href` say, and
 * `/hrms/admin/<id>` is the route that actually renders.
 *
 * `redirect()` wants the first — it sends the browser somewhere. `revalidatePath`
 * wants the second — it names a route in the App Router. Passing the browser
 * path to `revalidatePath` is not an error: it matches no route, invalidates
 * nothing, and returns quietly. Every HRMS action did exactly that, and it went
 * unnoticed because each one also redirected, and a redirect re-renders on the
 * server regardless. The first action written without a redirect — attaching a
 * document, which should leave you on the tab you are already looking at —
 * uploaded the file, saved the row, and showed an unchanged page.
 *
 * So: pass the same path you would pass to `redirect()`, and let this add the
 * prefix.
 */
export function revalidateHrms(path: string): void {
  revalidatePath(`/hrms${path}`)
}

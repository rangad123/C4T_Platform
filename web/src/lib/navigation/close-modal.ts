import 'server-only'
import { redirect, RedirectType } from 'next/navigation'

/**
 * End a Server Action that was submitted from a URL-driven modal.
 *
 * ── THE BUG THIS EXISTS TO FIX
 *
 * `Modal` is open while the URL says `?edit=…`, so opening one is a history
 * entry. `redirect()` inside a Server Action defaults to PUSH (confirmed in
 * `node_modules/next/dist/docs/.../redirect.md`: "`push` (default in Server
 * Actions)"), so saving added a SECOND entry on top of the modal's.
 *
 * The result: save the form, press Back, and the modal reopens — showing an
 * edit form for changes that were already written. It reads as "my save was
 * undone" or "the wrong page loaded", and escaping it takes several more
 * presses because every modal state is its own entry.
 *
 * Replacing instead drops the modal's URL from history, so Back goes to
 * wherever the reader actually came from — the list they opened the record
 * from.
 *
 * ── WHEN TO USE THIS, AND WHEN NOT TO
 *
 * Use it for the redirect that CLOSES a modal (the success path, and any
 * failure path that also drops `edit=`). Do not use it for a redirect that is
 * a genuine navigation the reader should be able to come back from — creating
 * a project and landing on it, say, where Back to the create form is
 * reasonable. Those keep the push default.
 *
 * A failure path that REOPENS the modal (`?edit=…&error=…`) should also use
 * this: it is replacing one modal state with another, not adding one.
 */
export function closeModal(href: string): never {
  redirect(href, RedirectType.replace)
}

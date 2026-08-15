/**
 * The `@auth` slot's default renderer.
 *
 * `default.tsx` is rendered when the slot does not match the active URL —
 * i.e. when the user is on any marketing page that does not have a
 * corresponding intercepting route. Returning `null` means the modal is
 * not rendered and the marketing page takes the full viewport.
 *
 * Without this file, Next.js would render a 404 for the unmatched slot on
 * a hard navigation (refresh, deep-link), which would prevent the
 * marketing page from rendering at all.
 */
export default function Default() {
  return null
}

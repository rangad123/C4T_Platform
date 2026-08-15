import { AuthModal } from '@/components/auth/AuthBackdrop'
import LoginForm from '@/app/(marketing)/login/form'

/**
 * The intercepting route for `/login`.
 *
 * When the user clicks the "Sign in" link in the top nav while on a
 * marketing page, Next.js renders this instead of the full `/login/page.tsx`.
 * The marketing page underneath stays mounted, so the modal opens over it.
 *
 * The form content is the same Server Component that the full page renders
 * — same Server Action, same validation, same error mapping. The only
 * difference is the chrome: this version wraps the form in the `<dialog>`
 * modal so it appears over the previous page.
 *
 * The modal route reads its own `searchParams` and forwards them to the
 * form. Without this, the `?error=`, `?email=`, and `?next=` that the
 * Server Action redirects with never reach the modal — refresh, deep-link,
 * and direct visits to `/login?error=…` work, but the modal would not
 * show the error banner.
 *
 * Why a separate file and not an inline "is modal" branch on the page:
 * the page is the canonical URL — refresh, deep-link, link-share — and must
 * render as a full page. The intercepting route is the "soft navigation"
 * variant. Same content, different chrome, two different files.
 */
export default async function InterceptedLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string }>
}) {
  const params = await searchParams
  return (
    <AuthModal>
      <LoginForm searchParams={Promise.resolve(params)} />
    </AuthModal>
  )
}

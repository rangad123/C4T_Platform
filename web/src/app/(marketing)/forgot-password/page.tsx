import type { Metadata } from 'next'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'
import ForgotPasswordForm from './form'

/**
 * `robots` matters more here than the title.
 *
 * Every other auth page is noindex; these two were not, so a password
 * screen could be crawled and listed. Nothing here is useful in a search
 * result and a reset form least of all -- the page is only ever reached
 * from a link in a mail.
 */
export const metadata: Metadata = {
  title: 'Reset your password',
  robots: { index: false, follow: false },
}

/**
 * `/forgot-password` — the full-page form.
 *
 * `@auth/(.)forgot-password` renders the same form as a dialog when this is
 * reached by a client-side navigation, which is every route into it from
 * inside the site. This page is what a refresh, a pasted URL or a hard load
 * gets, and it sits on the same dark band as the dialog's backdrop so the two
 * read as one screen arrived at differently.
 *
 * Centred and held to `--container-form`, the same as /login and /register.
 * Without the ceiling the card took the full width of the marketing
 * container, which stretched a single email field and its button across the
 * whole viewport -- a 1,900px input for an address.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; error?: string }>
}) {
  const params = await searchParams

  return (
    <AuthPage withLogo>
      <AuthCard raised={false}>
        <ForgotPasswordForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthPage>
  )
}

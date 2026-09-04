import type { Metadata } from 'next'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'
import ResetPasswordForm from './form'

/**
 * `robots` matters more here than the title.
 *
 * Every other auth page is noindex; these two were not, so a password
 * screen could be crawled and listed. Nothing here is useful in a search
 * result and a reset form least of all -- the page is only ever reached
 * from a link in a mail.
 */
export const metadata: Metadata = {
  title: 'Choose a new password',
  robots: { index: false, follow: false },
}

/**
 * `/reset-password` — the full-page form, and the one that actually runs.
 *
 * The reader arrives from a link in an email, which is a hard load with no
 * page underneath, so `@auth/(.)reset-password` never intercepts it. That
 * interceptor exists for consistency rather than for this path; see the note
 * in `form.tsx`.
 *
 * Centred and held to `--container-form`, the same as /login and /register.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>
}) {
  const params = await searchParams

  return (
    <AuthPage withLogo>
      <AuthCard raised={false}>
        <ResetPasswordForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthPage>
  )
}

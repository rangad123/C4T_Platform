import type { Metadata } from 'next'
import { AuthCard, AuthPage } from '@/components/auth/AuthCard'
import VerifyEmailForm from './form'

/**
 * Reached only from the link in the verification email — never crawled,
 * same reasoning as /reset-password.
 */
export const metadata: Metadata = {
  title: 'Verify your email',
  robots: { index: false, follow: false },
}

/**
 * `/verify-email` — the page the emailed link actually points to.
 *
 * It did not exist before this fix: `verificationEmail()` in the API's
 * mailer has always linked here, but nothing in this app answered the
 * route, so every Tester/Customer verification link 404'd and accounts sat
 * in PENDING_VERIFICATION indefinitely. Same standalone-page treatment as
 * /reset-password — a hard load from an email has no page underneath for
 * `@auth/(.)*` to intercept, so this is not added to that parallel slot.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>
}) {
  const params = await searchParams

  return (
    <AuthPage>
      <AuthCard>
        <VerifyEmailForm searchParams={Promise.resolve(params)} />
      </AuthCard>
    </AuthPage>
  )
}

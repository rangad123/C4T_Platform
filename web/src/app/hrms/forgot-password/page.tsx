import type { Metadata } from 'next'
import { HrAuthCard } from '../HrAuthCard'
import { HrForgotPasswordForm } from './form'

export const metadata: Metadata = {
  title: 'Forgot password',
  robots: { index: false, follow: false },
}

export default function HrForgotPasswordPage() {
  return (
    <HrAuthCard
      title="Forgot your password?"
      subtitle="We'll email you a link to set a new one."
      footer={{ href: '/login', label: 'Back to sign in' }}
    >
      <HrForgotPasswordForm />
    </HrAuthCard>
  )
}

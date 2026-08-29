import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Textarea } from '@/components/ds/forms/Textarea'
import { requestRemoteQaAction } from './actions'

const ROOT = { label: 'Customer', href: '/app/customer' }

/**
 * `/app/customer/remote-qa` — §49.
 *
 * ── WHY THIS PAGE IS AN ENQUIRY AND NOT A FEATURE
 *
 * The reference product has a Remote QA item in its navigation and the page
 * behind it is blank — the recording shows the click and an empty screen. So
 * there is no workflow to port and no backend anywhere in this platform that
 * implements one.
 *
 * The brief anticipated exactly this ("if the legacy video only demonstrates
 * the entry point and there is no existing backend capability, create the
 * appropriate architecture without inventing unsupported business logic; do
 * not leave a blank page"). Inventing a booking or session system would be
 * fabricating a product nobody specified.
 *
 * So the page does the one honest thing available: explains what the service
 * is in terms the platform can actually stand behind, and files a REAL
 * enquiry through the leads module an admin already works. Nothing here
 * pretends to schedule anything.
 */

const NOTICES: Record<string, NoticeCopy> = {
  sent: {
    tone: 'success',
    message: 'Your enquiry has been sent. Someone will come back to you by email.',
  },
  message: { tone: 'warning', message: 'Tell us what you need before sending.' },
  throttled: {
    tone: 'warning',
    message: 'That is a lot of enquiries in a short time. Try again in a few minutes.',
  },
  failed: { tone: 'error', message: 'That enquiry could not be sent. Try again in a moment.' },
}

interface MyOrganisation {
  id: string
  name: string
}

export default async function RemoteQaPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>
}) {
  await requireRole(['CUSTOMER'])
  const { notice } = await searchParams

  const mine = await serverFetchOrNull<readonly MyOrganisation[]>('organisations/mine')
  const organisation = mine?.[0]

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Remote QA' }]}
      eyebrow="Delivery"
      title="Remote QA"
      subtitle="A dedicated tester working alongside your team, rather than a crowd on a fixed-scope test."
    >
      <Notice code={notice} notices={NOTICES} />

      <Panel title="How this differs from a crowd test">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
            color: 'var(--text-secondary)',
            maxWidth: '70ch',
          }}
        >
          <p style={{ margin: 0 }}>
            A crowd test is scoped up front: you set a build, a window and a number of testers, and
            reports come back against it. Remote QA is the other shape — continuous testing from
            someone embedded with your team, working to your priorities as they change.
          </p>
          <p style={{ margin: 0 }}>
            It is arranged directly rather than booked from here, because the fit depends on your
            stack, your release cadence and how long you need someone. Tell us what you are after
            and the team will come back to you.
          </p>
        </div>
      </Panel>

      <Panel title="Tell us what you need" description="This goes straight to the Crowd4Test team.">
        <form
          action={requestRemoteQaAction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 'var(--space-5)',
            }}
          >
            <Field label="Company" htmlFor="company">
              <Input
                id="company"
                name="company"
                maxLength={160}
                defaultValue={organisation?.name ?? ''}
              />
            </Field>
            <Field
              label="Team size"
              htmlFor="teamSize"
              hint="Roughly how many people are building the product."
            >
              <Input id="teamSize" name="teamSize" maxLength={40} placeholder="10–20" />
            </Field>
          </div>

          <Field
            label="What do you need?"
            htmlFor="message"
            required
            hint="What you are building, how often you release, and how long you would want someone for."
          >
            <Textarea id="message" name="message" rows={6} required maxLength={4000} />
          </Field>

          <div>
            <SubmitButton variant="primary" pendingLabel="Sending your enquiry…">
              Send enquiry
            </SubmitButton>
          </div>
        </form>
      </Panel>
    </DetailShell>
  )
}

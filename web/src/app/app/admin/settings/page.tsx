import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { DetailShell } from '@/components/admin/DetailShell'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { SingleFileUpload } from '@/components/admin/SingleFileUpload'
import { formatDateTime } from '@/lib/admin/format'
import { setNdaTemplateAction } from './actions'

const ROOT = { label: 'Admin', href: '/app/admin' }

/** `GET /v1/settings/nda-template` — null until one is published. */
interface NdaTemplate {
  fileId: string
  name: string
  sizeBytes: string
  updatedAt: string
}

const NOTICES: Record<string, NoticeCopy> = {
  'nda-saved': {
    tone: 'success',
    message: 'The NDA is published. Testers can download it from their profile.',
  },
  'nda-failed': {
    tone: 'error',
    message: 'That document could not be published. Try uploading it again.',
  },
}

/**
 * `/app/admin/settings` — platform-wide settings.
 *
 * One setting so far: the blank NDA testers download to sign. It lives here
 * rather than as a file in the repo because the wording belongs to the client
 * and will change without a deploy — a legal document is not something an
 * engineer should be editing in a pull request.
 */
export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>
}) {
  /**
   * Administrators only.
   *
   * These are platform-wide values every account inherits, so this is not a
   * scope to hand out with a read permission — and the nav already hides it
   * from a sub-admin. A hidden link that still opens when typed is not a
   * gate, so the two say the same thing.
   */
  await requireRole(['ADMIN'])
  const { notice } = await searchParams

  const template = await serverFetchOrNull<NdaTemplate | null>('settings/nda-template')

  return (
    <DetailShell
      root={ROOT}
      crumbs={[{ label: 'Settings' }]}
      eyebrow="Operations"
      title="Settings"
      subtitle="Platform-wide values every account sees."
    >
      <Notice code={notice} notices={NOTICES} />

      <Panel
        title="Non-disclosure agreement"
        description="The blank NDA a tester downloads, signs and uploads back on their profile."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <DescriptionList
            items={[
              { label: 'Published document', value: template?.name ?? 'None yet' },
              {
                label: 'Last updated',
                value: template ? formatDateTime(template.updatedAt) : '—',
              },
            ]}
          />

          <p
            style={{
              margin: 0,
              color: 'var(--text-secondary)',
              fontSize: 'var(--type-body-sm-size)',
              maxWidth: '70ch',
            }}
          >
            Until one is published, no download link appears on the tester profile — an empty link
            is worse than none. Replacing this document does not re-open NDAs testers have already
            accepted.
          </p>

          <SingleFileUpload
            endpoint="/app/admin/upload"
            scope="platform-document"
            accept="application/pdf"
            label={template ? 'Replace the NDA' : 'Publish an NDA'}
            onUploaded={setNdaTemplateAction}
            currentName={template?.name ?? null}
          />
        </div>
      </Panel>
    </DetailShell>
  )
}

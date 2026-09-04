import { DetailShell } from '@/components/admin/DetailShell'
import { ComposeWorkspace } from '@/components/admin/communication/ComposeWorkspace'
import type { Candidate, CandidateMeta } from '@/components/admin/assign/types'
import { serverFetch, serverFetchOrNull, serverFetchPage } from '@/lib/api/server'
import { testerFilterOptions, type CatalogPayload } from '@/lib/admin/tester-filters'
import { requirePermission } from '@/lib/auth/session'

/**
 * `/app/admin/communication/compose` — write and send one message to many
 * testers.
 *
 * A route of its own rather than a panel on the Communication landing page.
 * Composing has real steps (write, choose recipients, review) and the landing
 * page's job is now the archive of what has already been sent; putting a
 * three-step task inside a list page is what made the old composer a textarea
 * bolted above a tester table.
 *
 * The server authorises, loads the vocabularies the picker needs, renders the
 * first page of recipients so the workspace opens with rows rather than a
 * spinner, and then gets out of the way — everything after that is client
 * state that must survive filtering and paging.
 */

interface TemplateRow {
  id: string
  name: string
  subject: string | null
  body: string
}

interface DraftPayload {
  id: string
  subject: string | null
  body: string
  status: string
  template: { id: string; name: string } | null
  recipients: readonly {
    user: {
      id: string
      email: string
      firstName: string | null
      lastName: string | null
      avatarFileId: string | null
    }
  }[]
}

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string }>
}) {
  await requirePermission('communication.write')

  const { draft: draftId } = await searchParams

  const [recipients, catalog, templates, draft] = await Promise.all([
    serverFetchPage<Candidate>('testers/message-recipients', {
      query: { status: 'VERIFIED', limit: 25, page: 1, sort: 'ratingAverage', order: 'desc' },
    }).catch(() => ({ data: [] as Candidate[], meta: { total: 0, page: 1, limit: 25 } })),
    serverFetch<CatalogPayload>('catalog').catch(() => null),
    serverFetch<TemplateRow[]>('communication/templates').catch(() => [] as TemplateRow[]),
    /**
     * `serverFetchOrNull`, so reopening a draft that was deleted in another
     * tab gives an empty composer rather than a 404 page — the message is
     * gone either way, and refusing to open the composer helps nobody.
     */
    draftId
      ? serverFetchOrNull<DraftPayload>(`communication/broadcasts/${draftId}`)
      : Promise.resolve(null),
  ])

  /**
   * A SENT broadcast is the record of what went out, and the API refuses to
   * edit one. Loading it into the composer would offer a Save button that
   * cannot work, so it is ignored here and the reader gets a blank composer.
   */
  const editable = draft && draft.status !== 'SENT' ? draft : null

  return (
    <DetailShell
      root={{ label: 'Admin', href: '/app/admin' }}
      crumbs={[
        { label: 'Communication', href: '/app/admin/communication' },
        { label: editable ? 'Edit draft' : 'New message' },
      ]}
      eyebrow="Operations"
      title={editable ? 'Edit draft' : 'New message'}
      subtitle="Each recipient gets a private conversation with you — nobody sees who else received it."
    >
      <ComposeWorkspace
        options={testerFilterOptions(catalog)}
        templates={Array.isArray(templates) ? templates : []}
        initialCandidates={recipients.data}
        initialMeta={recipients.meta as CandidateMeta}
        draft={
          editable
            ? {
                id: editable.id,
                subject: editable.subject,
                body: editable.body,
                templateId: editable.template?.id ?? null,
                recipients: editable.recipients.map((r) => r.user),
              }
            : null
        }
      />
    </DetailShell>
  )
}

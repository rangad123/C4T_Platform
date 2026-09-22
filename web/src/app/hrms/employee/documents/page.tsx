import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { DownloadLink } from '@/components/admin/DownloadLink'
import { SingleFileUpload } from '@/components/admin/SingleFileUpload'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Select } from '@/components/ds/forms/Select'
import { addOwnDocument } from './actions'

export const metadata: Metadata = { title: 'Documents' }

const BASE = '/employee/documents'

/** The only kinds an employee may label their own upload with — see hr-self.routes.ts. */
const KINDS = [
  { value: 'CV', label: 'CV' },
  { value: 'Identity proof', label: 'Identity proof' },
  { value: 'Other', label: 'Other' },
]

/** Mirrors `MAX_DOCUMENTS_PER_EMPLOYEE` in the API — one cap, shared with whatever HR has added. */
const MAX_DOCUMENTS = 10

interface DocumentRow {
  id: string
  kind: string
  fileId: string
  originalName: string
  sizeBytes: number
  available: boolean
  uploadedBy: string
  createdAt: string
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

/**
 * Everything on this employee's personnel file — whatever HR has attached,
 * plus whatever they have added themselves. Uploading is open (CV, identity
 * proof, or something else); there is no remove control here at all — a
 * document, once added, is HR's to retire, not the employee's. See
 * `hr-self.routes.ts` for the matching backend rule.
 */
export default async function HrEmployeeDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ docKind?: string; docError?: string }>
}) {
  const params = await searchParams
  const documents = (await serverFetchOrNull<DocumentRow[]>('hrms/me/documents')) ?? []
  const atLimit = documents.length >= MAX_DOCUMENTS
  const selectedKind = KINDS.find((k) => k.value === params.docKind)?.value ?? KINDS[0]!.value

  const columns: readonly TableColumn<DocumentRow>[] = [
    { key: 'kind', header: 'Kind', render: (row) => row.kind },
    {
      key: 'file',
      header: 'File',
      interactive: true,
      render: (row) => (
        <DownloadLink
          fileId={row.fileId}
          name={row.originalName}
          basePath="/files"
          available={row.available}
        />
      ),
      renderSecondary: (row) => fileSize(row.sizeBytes),
    },
    {
      key: 'added',
      header: 'Added',
      render: (row) => new Date(row.createdAt).toLocaleDateString(),
      renderSecondary: (row) => `by ${row.uploadedBy}`,
    },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Documents' }]}
      root={{ label: 'Employee', href: '/employee' }}
      eyebrow="Documents"
      title="Documents"
      subtitle="Your CV, identity proof and anything HR has attached to your record."
    >
      <Panel
        title="Documents"
        description={`Up to ${MAX_DOCUMENTS} in total, HR's and yours together. ${documents.length} of ${MAX_DOCUMENTS} used.`}
        actions={
          atLimit ? undefined : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-4)',
                flexWrap: 'wrap',
              }}
            >
              <LiveGetForm
                action={BASE}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
              >
                <label
                  htmlFor="docKind"
                  style={{
                    fontSize: 'var(--type-body-sm-size)',
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Kind
                </label>
                <Select id="docKind" name="docKind" options={KINDS} defaultValue={selectedKind} />
                <LiveFormStatus />
              </LiveGetForm>
              <SingleFileUpload
                endpoint="/admin/upload"
                scope="document"
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                label="Upload document"
                onUploaded={addOwnDocument.bind(null, selectedKind)}
              />
            </div>
          )
        }
      >
        {params.docError ? (
          <p
            role="alert"
            style={{
              margin: '0 0 var(--space-5)',
              padding: 'var(--space-4) var(--space-5)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              borderRadius: 'var(--radius-input)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            {params.docError}
          </p>
        ) : null}

        <Table
          ariaLabel="Your documents"
          columns={columns}
          rows={documents}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              icon="file-text"
              title="No documents yet"
              description="Choose what the file is, then upload it. PDF, Word or an image, up to 20 MB."
            />
          }
        />

        {atLimit ? (
          <p
            style={{
              margin: 'var(--space-5) 0 0',
              color: 'var(--text-muted)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            Your record has the maximum of {MAX_DOCUMENTS} documents. Ask HR to remove one before
            adding another.
          </p>
        ) : null}
      </Panel>
    </HrPageShell>
  )
}

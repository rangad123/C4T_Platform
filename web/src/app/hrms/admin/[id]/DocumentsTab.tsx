import { serverFetchOrNull } from '@/lib/api/server'
import { LiveGetForm, LiveFormStatus } from '@/components/admin/LiveGetForm'
import { Panel } from '@/components/admin/Panel'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { DownloadLink } from '@/components/admin/DownloadLink'
import { SingleFileUpload } from '@/components/admin/SingleFileUpload'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Select } from '@/components/ds/forms/Select'
import { addEmployeeDocument, removeEmployeeDocument } from './actions'

/**
 * What a personnel file usually holds. The column underneath is free text, so
 * this list is a convenience for the common cases rather than a constraint —
 * an admin who needs something else picks "Other" and the file name says what
 * it is.
 */
const KINDS = [
  { value: 'CV', label: 'CV' },
  { value: 'Offer letter', label: 'Offer letter' },
  { value: 'Increment letter', label: 'Increment letter' },
  { value: 'Relieving letter', label: 'Relieving letter' },
  { value: 'Identity proof', label: 'Identity proof' },
  { value: 'Other', label: 'Other' },
]

/** Mirrors `MAX_DOCUMENTS_PER_EMPLOYEE` in the API, for the copy only. */
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

export async function DocumentsTab({
  employeeId,
  detailPath,
  kind,
  error,
}: {
  employeeId: string
  detailPath: string
  kind: string | undefined
  error: string | undefined
}) {
  const documents =
    (await serverFetchOrNull<DocumentRow[]>(`hrms/employees/${employeeId}/documents`)) ?? []
  const atLimit = documents.length >= MAX_DOCUMENTS
  // An unknown kind in the URL falls back rather than being trusted into the
  // body — the API takes free text, so this is the one place the list applies.
  const selectedKind = KINDS.find((k) => k.value === kind)?.value ?? KINDS[0]!.value

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
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <form action={removeEmployeeDocument.bind(null, employeeId, row.id)}>
          <ConfirmSubmit question={`Remove ${row.originalName}?`}>Remove</ConfirmSubmit>
        </form>
      ),
    },
  ]

  return (
    <Panel
      title="Documents"
      description={`CVs, offer letters and the like — up to ${MAX_DOCUMENTS} per employee. ${documents.length} of ${MAX_DOCUMENTS} used.`}
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
            {/* The kind is chosen before the file, and carried in the URL so
                the Server Component can bind it into the attach action. */}
            <LiveGetForm
              action={detailPath}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
            >
              <input type="hidden" name="section" value="documents" />
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
              onUploaded={addEmployeeDocument.bind(null, employeeId, selectedKind)}
            />
          </div>
        )
      }
    >
      {error ? (
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
          {error}
        </p>
      ) : null}

      <Table
        ariaLabel="Employee documents"
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
          This employee has the maximum of {MAX_DOCUMENTS} documents. Remove one to add another.
        </p>
      ) : null}
    </Panel>
  )
}

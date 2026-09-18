import type { Metadata } from 'next'
import { serverFetchOrNull } from '@/lib/api/server'
import { HrPageShell } from '@/components/hrms/HrPageShell'
import { Panel } from '@/components/admin/Panel'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { Button } from '@/components/ds/core/Button'
import { SingleFileUpload } from '@/components/admin/SingleFileUpload'
import { ConfirmSubmit } from '@/components/admin/ConfirmSubmit'
import { createTemplate, deleteTemplate } from './actions'

export const metadata: Metadata = { title: 'Templates' }

interface TemplateRow {
  id: string
  name: string
  description: string | null
  createdAt: string
  file: { originalName: string; sizeBytes: number }
  uploadedBy: { firstName: string; lastName: string }
  downloadUrl: string
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default async function HrAdminTemplatesPage() {
  const templates = await serverFetchOrNull<TemplateRow[]>('hrms/templates')

  const columns: readonly TableColumn<TemplateRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => row.name,
      renderSecondary: (row) => row.file.originalName,
    },
    { key: 'size', header: 'Size', render: (row) => fileSize(row.file.sizeBytes) },
    {
      key: 'uploadedBy',
      header: 'Uploaded by',
      render: (row) => `${row.uploadedBy.firstName} ${row.uploadedBy.lastName}`,
    },
    {
      key: 'createdAt',
      header: 'Uploaded',
      render: (row) => new Date(row.createdAt).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) => (
        <span style={{ display: 'inline-flex', gap: 'var(--space-3)' }}>
          <Button
            href={row.downloadUrl}
            variant="secondary"
            size="sm"
            iconLeft="download"
            prefetch={false}
          >
            Download
          </Button>
          <form action={deleteTemplate.bind(null, row.id)}>
            <ConfirmSubmit question={`Delete "${row.name}"?`} size="sm" iconLeft="trash-2">
              Delete
            </ConfirmSubmit>
          </form>
        </span>
      ),
    },
  ]

  return (
    <HrPageShell
      crumbs={[{ label: 'Templates' }]}
      root={{ label: 'Admin', href: '/admin' }}
      eyebrow="Templates"
      title="Templates"
      subtitle="Reusable documents — offer letters, appraisal forms and the like."
    >
      <Panel
        title="Uploaded templates"
        actions={
          <SingleFileUpload
            endpoint="/admin/upload"
            scope="template"
            accept=".pdf,.doc,.docx,.ppt,.pptx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            label="Upload template"
            onUploaded={createTemplate}
          />
        }
      >
        {templates && templates.length > 0 ? (
          <Table
            ariaLabel="Templates"
            columns={columns}
            rows={templates}
            rowKey={(row) => row.id}
          />
        ) : (
          <EmptyState
            icon="file-text"
            title="No templates uploaded"
            description="Upload a DOCX, PPTX or PDF template to get started."
          />
        )}
      </Panel>
    </HrPageShell>
  )
}

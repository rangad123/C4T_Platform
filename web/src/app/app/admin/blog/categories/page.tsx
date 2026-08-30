import { Topbar } from '@/components/admin/Topbar'
import { Panel } from '@/components/admin/Panel'
import { Modal } from '@/components/admin/Modal'
import { Notice, type NoticeCopy } from '@/components/admin/Notice'
import { Table, type TableColumn } from '@/components/ds/admin/Table'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { Badge } from '@/components/ds/core/Badge'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Textarea } from '@/components/ds/forms/Textarea'
import { serverFetchOrNull } from '@/lib/api/server'
import { requirePermission, hasPermission } from '@/lib/auth/session'
import { createCategoryAction, updateCategoryAction, toggleCategoryActiveAction } from './actions'

const BASE = '/app/admin/blog/categories'
const ROOT = { label: 'Blog', href: '/app/admin/blog' }

interface CategoryRow {
  id: string
  name: string
  slug: string
  description: string | null
  isActive: boolean
  postCount: number
}

const NOTICES: Record<string, NoticeCopy> = {
  created: { tone: 'success', message: 'Category created.' },
  updated: { tone: 'success', message: 'Category updated.' },
  reactivated: { tone: 'success', message: 'Category reactivated — it can be used on posts again.' },
  retired: { tone: 'success', message: 'Category retired. Existing posts keep it; it will no longer be offered on new ones.' },
  failed: { tone: 'error', message: "That didn't work. Try again." },
}

/**
 * `/app/admin/blog/categories` — the blog's topic taxonomy.
 *
 * A short reference list, not a paginated `AdminListPage` — categories are
 * curated by an admin, not something that grows into the hundreds the way
 * bugs or transactions do. Create/edit both happen in a `Modal`, per this
 * codebase's "small properties get a modal, the full editor gets its own
 * page" convention.
 */
export default async function BlogCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; edit?: string; error?: string; notice?: string; name?: string }>
}) {
  const user = await requirePermission('blog.manage_categories')
  const canWrite = hasPermission(user, 'blog.manage_categories')

  const params = await searchParams
  const categories = (await serverFetchOrNull<CategoryRow[]>('blog/categories/admin')) ?? []

  const newModalOpen = params.new === '1'
  const editingId = params.edit
  const editing = categories.find((c) => c.id === editingId)

  const columns: readonly TableColumn<CategoryRow>[] = [
    {
      key: 'name',
      header: 'Category',
      render: (row) => row.name,
      renderSecondary: (row) => row.description ?? row.slug,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={row.isActive ? 'success' : 'neutral'}>{row.isActive ? 'Active' : 'Retired'}</Badge>,
    },
    { key: 'posts', header: 'Posts', align: 'right', render: (row) => row.postCount },
    {
      key: 'actions',
      header: '',
      align: 'right',
      interactive: true,
      render: (row) =>
        canWrite ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
            <Button href={`${BASE}?edit=${row.id}`} variant="ghost" size="sm" iconLeft="pencil">
              Edit
            </Button>
            <form action={toggleCategoryActiveAction}>
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="isActive" value={(!row.isActive).toString()} />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                iconLeft={row.isActive ? 'eye-off' : 'eye'}
              >
                {row.isActive ? 'Retire' : 'Reactivate'}
              </Button>
            </form>
          </div>
        ) : null,
    },
  ]

  return (
    <>
      <Topbar crumbs={[{ label: 'Blog', href: '/app/admin/blog' }, { label: 'Categories' }]} root={{ label: 'Admin', href: '/app/admin' }} />
      <main
        id="main"
        style={{ padding: 'var(--space-9)', display: 'flex', flexDirection: 'column', gap: 'var(--space-7)' }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)', margin: 0 }}>
            Content
          </p>
          <h1 className="c4t-display-md" style={{ margin: 0 }}>
            Blog categories
          </h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '75ch' }}>
            The topic taxonomy shown on post cards and used to filter the public blog. Retiring a
            category keeps it on any post that already has it — it just stops being offered on new
            or edited posts.
          </p>
        </header>

        <Notice code={params.notice} notices={NOTICES} />

        {canWrite ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button href={`${BASE}?new=1`} variant="primary" size="sm" iconLeft="plus">
              New category
            </Button>
          </div>
        ) : null}

        <Panel flush>
          {categories.length === 0 ? (
            <EmptyState
              icon="tag"
              title="No categories yet"
              description="Create the first category before writing a post — every published post needs one."
            />
          ) : (
            <Table ariaLabel="Blog categories" columns={columns} rows={categories} rowKey={(row) => row.id} />
          )}
        </Panel>
      </main>

      {canWrite ? (
        <Modal open={newModalOpen} closedHref={BASE} title="New category">
          {params.error ? <ErrorBanner code={params.error} /> : null}
          <form action={createCategoryAction} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <Field label="Name" htmlFor="name" required hint="Shown on post cards and in the category filter — e.g. Software Testing.">
              <Input id="name" name="name" required defaultValue={params.name ?? ''} />
            </Field>
            <Field label="Description" htmlFor="description" hint="Optional. Shown at the top of the category's public page.">
              <Textarea id="description" name="description" rows={3} />
            </Field>
            <SubmitButton variant="primary" iconLeft="check" pendingLabel="Creating…">
              Create category
            </SubmitButton>
          </form>
        </Modal>
      ) : null}

      {canWrite && editing ? (
        <Modal open={Boolean(editingId)} closedHref={BASE} title="Edit category">
          {params.error ? <ErrorBanner code={params.error} /> : null}
          <form action={updateCategoryAction} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <input type="hidden" name="id" value={editing.id} />
            <Field label="Name" htmlFor="edit-name" required>
              <Input id="edit-name" name="name" required defaultValue={editing.name} />
            </Field>
            <Field label="Description" htmlFor="edit-description">
              <Textarea id="edit-description" name="description" rows={3} defaultValue={editing.description ?? ''} />
            </Field>
            <SubmitButton variant="primary" iconLeft="check" pendingLabel="Saving…">
              Save changes
            </SubmitButton>
          </form>
        </Modal>
      ) : null}
    </>
  )
}

function ErrorBanner({ code }: { code: string }) {
  return (
    <div
      role="alert"
      style={{
        padding: 'var(--space-4) var(--space-5)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-input)',
        background: 'var(--status-error-bg)',
        color: 'var(--status-error-fg)',
        fontSize: 'var(--type-body-sm-size)',
      }}
    >
      {code === 'duplicate'
        ? 'A category with that name already exists.'
        : "That didn't work. Check the form and try again."}
    </div>
  )
}

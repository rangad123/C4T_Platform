import { DetailShell } from '@/components/admin/DetailShell'
import { Panel } from '@/components/admin/Panel'
import { Button } from '@/components/ds/core/Button'
import { SubmitButton } from '@/components/ds/core/SubmitButton'
import { Field } from '@/components/ds/forms/Field'
import { Input } from '@/components/ds/forms/Input'
import { Select } from '@/components/ds/forms/Select'
import { BLOG_TEMPLATE_OPTIONS } from '@/lib/admin/blog-templates'
import { TrackedForm } from '@/components/ds/forms/TrackedForm'
import { requirePermission } from '@/lib/auth/session'
import { createPostAction } from '../actions'

/**
 * `/app/admin/blog/new` — starts a post from just a title.
 *
 * Everything else (content, category, tags, featured image, SEO, publishing)
 * happens on the editor page this redirects into once the post exists — the
 * same "minimal create, then a real detail page for everything else" shape
 * `organisations/new` already uses.
 */
export default async function NewBlogPostPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; title?: string }>
}) {
  await requirePermission('blog.write')

  const params = await searchParams
  const backHref = '/app/admin/blog'

  return (
    <DetailShell
      crumbs={[{ label: 'Blog', href: backHref }, { label: 'New' }]}
      eyebrow="Content"
      title="New post"
      subtitle="Start with a title — the slug, content, category and everything else are set on the next page."
    >
      <Panel title="Title">
        {params.error ? (
          <div
            role="alert"
            style={{
              marginBottom: 'var(--space-6)',
              padding: 'var(--space-4) var(--space-5)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-input)',
              background: 'var(--status-error-bg)',
              color: 'var(--status-error-fg)',
              fontSize: 'var(--type-body-sm-size)',
            }}
          >
            Couldn&apos;t create the post. Check the title and try again.
          </div>
        ) : null}

        <TrackedForm
          action={createPostAction}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
        >
          <Field
            label="Title"
            htmlFor="title"
            required
            hint="You can change this any time from the editor."
          >
            <Input
              id="title"
              name="title"
              required
              minLength={3}
              defaultValue={params.title ?? ''}
            />
          </Field>

          {/*
            The template only seeds the editor — it is not stored, and it is
            applied on the next screen rather than here, because the create
            endpoint accepts a title and nothing else. Carried across on the
            redirect, and ignored there if the body is not empty.
          */}
          <Field
            label="Start from"
            htmlFor="template"
            hint="A skeleton of headings you write over. Choose Blank post to start from nothing."
          >
            <Select id="template" name="template" defaultValue="" options={BLOG_TEMPLATE_OPTIONS} />
          </Field>

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <SubmitButton variant="primary" iconLeft="check" pendingLabel="Creating post…">
              Create post
            </SubmitButton>
            <Button type="button" variant="ghost" href={backHref}>
              Cancel
            </Button>
          </div>
        </TrackedForm>
      </Panel>
    </DetailShell>
  )
}

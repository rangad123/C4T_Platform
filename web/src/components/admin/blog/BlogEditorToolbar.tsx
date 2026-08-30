'use client'

import { useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { IconButton } from '@/components/ds/core/IconButton'
import { uploadEditorImage } from './ImageUploadCommand'
import styles from './BlogEditor.module.css'

/**
 * The editor's formatting toolbar — covers every content type §9-10 of the
 * blog spec asks for: headings, text formatting, links, lists, blockquotes,
 * code, images (via `uploadEditorImage`), tables, a horizontal rule, a
 * YouTube/Vimeo embed, and the custom Callout block. Built from this site's
 * own `IconButton`, not a library's default toolbar skin.
 */
export function BlogEditorToolbar({ editor: editorProp }: { editor: Editor | null }) {
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageBusy, setImageBusy] = useState(false)

  if (!editorProp) {
    return <div className={styles.toolbar} aria-hidden="true" />
  }
  // A `const` initialized from an already-narrowed value keeps its narrow
  // type (`Editor`, not `Editor | null`) inside every closure below —
  // TypeScript doesn't preserve narrowing on a captured function PARAMETER
  // across closures (the parameter could, in principle, be reassigned), only
  // on a `const` whose type is fixed at declaration.
  const editor = editorProp

  async function handleImagePick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setImageError(null)
    setImageBusy(true)
    try {
      const { url, alt } = await uploadEditorImage(file)
      editor.chain().focus().setImage({ src: url, alt }).run()
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'That image could not be uploaded.')
    } finally {
      setImageBusy(false)
    }
  }

  function insertLink() {
    const previousUrl = (editor.getAttributes('link').href as string | undefined) ?? ''
    // eslint-disable-next-line no-alert -- a URL prompt is the plainest possible affordance for a single-value input; a full dialog is not warranted for one field.
    const url = window.prompt('Link URL', previousUrl || 'https://')
    if (url === null) return
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run()
  }

  function insertVideo() {
    // eslint-disable-next-line no-alert -- see insertLink above.
    const url = window.prompt('YouTube or Vimeo URL')
    if (!url) return
    editor.chain().focus().setYoutubeVideo({ src: url.trim() }).run()
  }

  function insertTable() {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  }

  return (
    <div>
      <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
        <div className={styles.group}>
          <IconButton
            icon="undo2"
            label="Undo"
            size="sm"
            disabled={!editor.can().undo()}
            onClick={() => editor.chain().focus().undo().run()}
          />
          <IconButton
            icon="redo2"
            label="Redo"
            size="sm"
            disabled={!editor.can().redo()}
            onClick={() => editor.chain().focus().redo().run()}
          />
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.group}>
          {([1, 2, 3, 4] as const).map((level) => (
            <button
              key={level}
              type="button"
              className={[
                styles.textButton,
                editor.isActive('heading', { level }) ? styles.active : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={`Heading ${level}`}
              aria-pressed={editor.isActive('heading', { level })}
              onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
            >
              H{level}
            </button>
          ))}
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.group}>
          <IconButton
            icon="bold"
            label="Bold"
            size="sm"
            variant={editor.isActive('bold') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <IconButton
            icon="italic"
            label="Italic"
            size="sm"
            variant={editor.isActive('italic') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <IconButton
            icon="strikethrough"
            label="Strikethrough"
            size="sm"
            variant={editor.isActive('strike') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <IconButton
            icon="code"
            label="Inline code"
            size="sm"
            variant={editor.isActive('code') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.group}>
          <IconButton
            icon="list"
            label="Bulleted list"
            size="sm"
            variant={editor.isActive('bulletList') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <IconButton
            icon="list-ordered"
            label="Numbered list"
            size="sm"
            variant={editor.isActive('orderedList') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <IconButton
            icon="quote"
            label="Quote"
            size="sm"
            variant={editor.isActive('blockquote') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          />
          <IconButton
            icon="info"
            label="Callout"
            size="sm"
            variant={editor.isActive('callout') ? 'filled' : 'ghost'}
            onClick={() => editor.chain().focus().setCallout().run()}
          />
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.group}>
          <IconButton
            icon="link-2"
            label="Link"
            size="sm"
            variant={editor.isActive('link') ? 'filled' : 'ghost'}
            onClick={insertLink}
          />
          <IconButton
            icon="image"
            label="Insert image"
            size="sm"
            disabled={imageBusy}
            onClick={() => imageInputRef.current?.click()}
          />
          <IconButton icon="table" label="Insert table" size="sm" onClick={insertTable} />
          <IconButton icon="video" label="Embed video" size="sm" onClick={insertVideo} />
          <IconButton
            icon="minus"
            label="Horizontal rule"
            size="sm"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          />
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={handleImagePick}
          hidden
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
      {imageError ? (
        <p role="alert" className={styles.imageError}>
          {imageError}
        </p>
      ) : null}
    </div>
  )
}

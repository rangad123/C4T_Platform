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
  /**
   * What the file picker does with what it gets.
   *
   * One input serves three buttons rather than three hidden inputs: the mode
   * is set just before the picker opens and read when it returns. Declared up
   * here with the other hooks — the early return below is conditional, and a
   * hook after it would not run on every render.
   */
  const imageModeRef = useRef<'plain' | 'caption' | 'row'>('plain')

  if (!editorProp) {
    return <div className={styles.toolbar} aria-hidden="true" />
  }
  // A `const` initialized from an already-narrowed value keeps its narrow
  // type (`Editor`, not `Editor | null`) inside every closure below —
  // TypeScript doesn't preserve narrowing on a captured function PARAMETER
  // across closures (the parameter could, in principle, be reassigned), only
  // on a `const` whose type is fixed at declaration.
  const editor = editorProp

  function pickImage(mode: 'plain' | 'caption' | 'row') {
    imageModeRef.current = mode
    imageInputRef.current?.click()
  }

  async function handleImagePick(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return

    const mode = imageModeRef.current
    setImageError(null)
    setImageBusy(true)
    try {
      if (mode === 'row') {
        // A row holds exactly two images, so it needs two files. Asking for
        // both in one pick beats opening the picker twice and leaving a
        // half-built row behind if the second one is cancelled.
        if (files.length < 2) {
          setImageError('Choose two images for a side-by-side row.')
          return
        }
        const [first, second] = files
        const [left, right] = await Promise.all([
          uploadEditorImage(first!),
          uploadEditorImage(second!),
        ])
        editor
          .chain()
          .focus()
          .setImageRow({ src: left.url, alt: '' }, { src: right.url, alt: '' })
          .run()
        return
      }

      const { url, alt } = await uploadEditorImage(files[0]!)
      if (mode === 'caption') {
        // Alt is deliberately left empty rather than seeded with the
        // filename the upload returns: "hero-shot-final-2.png" read aloud is
        // worse than nothing, and the caption below the image is what a
        // sighted reader gets. Set a real description with the button beside
        // this one.
        editor.chain().focus().setFigureImage({ src: url, alt: '' }).run()
      } else {
        editor.chain().focus().setImage({ src: url, alt }).run()
      }
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'That image could not be uploaded.')
    } finally {
      setImageBusy(false)
    }
  }

  /**
   * The description a screen reader announces for the selected image.
   *
   * Uses `prompt` for the same reason `insertLink` does — one value, and a
   * dialog for it would be more chrome than the field deserves.
   */
  function editImageDescription() {
    const node = editor.isActive('figureImage') ? 'figureImage' : 'image'
    const current = (editor.getAttributes(node).alt as string | undefined) ?? ''
    // eslint-disable-next-line no-alert -- see insertLink above.
    const next = window.prompt('Describe this image for someone who cannot see it', current)
    if (next === null) return
    editor.chain().focus().updateAttributes(node, { alt: next.trim() }).run()
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
            onClick={() => pickImage('plain')}
          />
          <IconButton
            icon="captions"
            label="Insert image with a caption"
            size="sm"
            disabled={imageBusy}
            onClick={() => pickImage('caption')}
          />
          <IconButton
            icon="columns-2"
            label="Insert two images side by side"
            size="sm"
            disabled={imageBusy}
            onClick={() => pickImage('row')}
          />
          <IconButton
            icon="images"
            label="Describe the selected image"
            size="sm"
            disabled={!editor.isActive('figureImage') && !editor.isActive('image')}
            onClick={editImageDescription}
          />
        </div>

        {/*
          Width applies to a captioned image only — the class it sets lives on
          the <figure>, which a bare <img> does not have. Shown only when one
          is selected rather than disabled, so the toolbar does not carry three
          dead controls for the whole time nobody is editing an image.
        */}
        {editor.isActive('figureImage') ? (
          <>
            <span className={styles.divider} aria-hidden="true" />
            <div className={styles.group}>
              {(['full', 'wide', 'inline'] as const).map((width) => (
                <button
                  key={width}
                  type="button"
                  className={[
                    styles.textButton,
                    editor.isActive('figureImage', { width }) ? styles.active : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-label={`Image width: ${width}`}
                  aria-pressed={editor.isActive('figureImage', { width })}
                  onClick={() => editor.chain().focus().setFigureWidth(width).run()}
                >
                  {width === 'full' ? 'Full' : width === 'wide' ? 'Wide' : 'Inline'}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <div className={styles.group}>
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
          multiple
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

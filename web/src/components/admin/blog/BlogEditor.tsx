'use client'

import { useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import Youtube from '@tiptap/extension-youtube'
import Placeholder from '@tiptap/extension-placeholder'
import { Callout } from './CalloutNode'
import { BlogEditorToolbar } from './BlogEditorToolbar'
import styles from './BlogEditor.module.css'

export interface BlogEditorProps {
  /** Hidden field name the surrounding `<form action={...}>` reads on submit. */
  name: string
  defaultValue: string
}

/**
 * The article body editor — headless Tiptap, our own toolbar and typography.
 *
 * Binds to a hidden, uncontrolled `<textarea>` via a ref rather than React
 * state: `onUpdate` writes `editor.getHTML()` straight into the DOM node on
 * every change, so the surrounding Server Action form picks up the current
 * HTML on submit exactly like any other field, without re-rendering this
 * component (and every button's active/inactive state) on each keystroke
 * beyond what Tiptap's own transaction re-render already does.
 *
 * Content is sanitized server-side before it's ever stored — see
 * `api/src/modules/blog/blog-content.ts` — so nothing here needs to sanitize
 * on the way out; this only needs to produce well-formed HTML.
 */
export function BlogEditor({ name, defaultValue }: BlogEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const editor = useEditor({
    // Required for a framework that renders on the server: without it,
    // Tiptap tries to render on the server too and the first client paint
    // mismatches, which React reports as a hydration error.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
      }),
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Youtube.configure({ nocookie: true, width: 640, height: 360 }),
      Placeholder.configure({ placeholder: 'Write the article…' }),
      Callout,
    ],
    content: defaultValue || '<p></p>',
    onUpdate: ({ editor }) => {
      if (textareaRef.current) textareaRef.current.value = editor.getHTML()
    },
    editorProps: {
      // The `?? ''` isn't optional-chaining defensiveness — this project's
      // tsconfig has `noUncheckedIndexedAccess`, so a CSS Modules import
      // types every class lookup as `string | undefined` even though it's
      // always defined at runtime; Tiptap's `attributes` wants a definite
      // `string`.
      attributes: { class: styles.content ?? '' },
    },
  })

  return (
    <div className={styles.wrapper}>
      <BlogEditorToolbar editor={editor} />
      <EditorContent editor={editor} />
      <textarea
        ref={textareaRef}
        name={name}
        defaultValue={defaultValue}
        hidden
        readOnly
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  )
}

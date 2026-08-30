import { Node, mergeAttributes } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wraps the current block(s) in a callout. */
      setCallout: () => ReturnType
      /** Lifts the current block(s) back out of the callout. */
      unsetCallout: () => ReturnType
    }
  }
}

/**
 * The "info box" content type from §9 of the blog spec — a plain
 * `<div class="c4t-callout">` wrapping one or more paragraphs. Kept as a
 * custom node rather than pulled from a package: it's a five-line block-quote
 * variant, not worth a dependency, and it needs to render with this site's
 * own tokens rather than a library's default styling.
 *
 * `sanitize-html` on the API allow-lists exactly `div.c4t-callout` and
 * nothing else about `div` — see `api/src/modules/blog/blog-content.ts` — so
 * this node's HTML output and the sanitizer's allow-list must be kept in
 * step if either one changes.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div.c4t-callout' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'c4t-callout' }), 0]
  },

  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    }
  },
})

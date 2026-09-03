import { Node, mergeAttributes } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageRow: {
      /** Inserts a row holding two captioned images side by side. */
      setImageRow: (
        left: { src: string; alt?: string },
        right: { src: string; alt?: string },
      ) => ReturnType
    }
  }
}

/**
 * Two captioned images side by side.
 *
 * A plain `<div class="c4t-two-up">` around two `figureImage` nodes. The
 * wrapper needs no sanitizer change at all: `div` has been the one element
 * allowed to carry a class since the Callout node was written, and unlike
 * `figure` its class values are not filtered.
 *
 * `insertContent` rather than Callout's `wrapIn`: a callout wraps the
 * paragraphs already under the cursor, whereas a row is built from two images
 * that do not exist yet — there is nothing to wrap.
 *
 * `content` is `figureImage{2}` so the row cannot be left holding one image,
 * which would render as a half-empty grid on the published page.
 */
export const ImageRow = Node.create({
  name: 'imageRow',
  group: 'block',
  content: 'figureImage{2}',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div.c4t-two-up' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'c4t-two-up' }), 0]
  },

  addCommands() {
    return {
      setImageRow:
        (left, right) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            content: [left, right].map((image) => ({
              type: 'figureImage',
              attrs: { src: image.src, alt: image.alt ?? '', width: 'full' },
            })),
          }),
    }
  },
})

import { Node, mergeAttributes } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    figureImage: {
      /** Inserts an image with an empty caption ready to type into. */
      setFigureImage: (attrs: { src: string; alt?: string }) => ReturnType
      /** Changes how wide the selected figure renders. */
      setFigureWidth: (width: FigureWidth) => ReturnType
    }
  }
}

export type FigureWidth = 'full' | 'wide' | 'inline'

const WIDTHS: readonly FigureWidth[] = ['full', 'wide', 'inline']

/** The class the API's sanitizer allow-lists for each width. */
export function figureWidthClass(width: FigureWidth): string {
  return `c4t-w-${width}`
}

function widthFromClass(className: string | null): FigureWidth {
  const found = WIDTHS.find((w) => className?.split(/\s+/).includes(figureWidthClass(w)))
  return found ?? 'full'
}

/**
 * An image with a caption under it, and a choice of how wide it renders.
 *
 * ── Why the width lives on the `<figure>` and not the `<img>`
 *
 * `sanitizeContent` allows exactly `src, alt, title, width, height` on an
 * `img`. A class there is deleted with no error, so a width written onto the
 * image would look correct in the editor, survive until the post was saved,
 * and simply be absent the next time it loaded. `figure` is the element the
 * caption already needs, one class governs image and caption together, and
 * `api/src/modules/blog/blog-content.ts` allow-lists exactly the three class
 * values below — nothing else on a figure survives, attributes included.
 *
 * ── Why parseHTML matches `figure` and never a bare `img`
 *
 * Matching `img` would look like a helpful migration and would instead
 * rewrite history: the editor re-parses stored HTML on open, and
 * `saveContentAction` always sends `content`, so simply opening a published
 * post and pressing Save would wrap every existing image in a figure with an
 * empty caption its author never wrote. Bare images stay bare, and stay on
 * the stock Image node.
 *
 * The caption is the node's content rather than an attribute so it is edited
 * in place like any other text — `contentElement` is what reads it back off
 * the `<figcaption>` when the post is reopened.
 */
export const FigureImage = Node.create({
  name: 'figureImage',
  group: 'block',
  content: 'inline*',
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      width: {
        default: 'full' as FigureWidth,
        // Rendered by `renderHTML` below rather than here: the class has to be
        // composed onto the `<figure>`, not emitted as its own attribute.
        renderHTML: () => ({}),
        parseHTML: (element: HTMLElement) => widthFromClass(element.getAttribute('class')),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'figure',
        contentElement: 'figcaption',
        getAttrs: (element: HTMLElement) => {
          const img = element.querySelector('img')
          // A figure with no image is not this node — let it fall through
          // rather than producing one with a null src.
          if (!img) return false
          return {
            src: img.getAttribute('src'),
            alt: img.getAttribute('alt'),
            width: widthFromClass(element.getAttribute('class')),
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    // `width` is pulled out and dropped on purpose: it is not an attribute
    // on the element, it is the class composed below.
    const { src, alt, width: _width, ...rest } = HTMLAttributes as Record<string, unknown>
    return [
      'figure',
      // `mergeAttributes` concatenates `class` rather than replacing it, so
      // the width is composed here from the node's own attribute instead of
      // being merged in — otherwise a figure could accumulate two width
      // classes and the sanitizer would keep both.
      mergeAttributes(rest, { class: figureWidthClass(node.attrs.width as FigureWidth) }),
      ['img', { src, alt: alt ?? '' }],
      ['figcaption', 0],
    ]
  },

  addCommands() {
    return {
      setFigureImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { src: attrs.src, alt: attrs.alt ?? '', width: 'full' },
          }),
      setFigureWidth:
        (width) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { width }),
    }
  },
})

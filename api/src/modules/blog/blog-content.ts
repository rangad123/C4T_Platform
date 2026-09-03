import sanitizeHtml from 'sanitize-html'

/**
 * Sanitizes admin-authored article HTML before it ever reaches Postgres.
 *
 * The editor runs in the browser and its output — plus anything pasted into
 * it — is never trusted. This allow-list covers exactly what §9 of the blog
 * spec asks the editor to produce: headings, text formatting, links, lists,
 * blockquotes, code, images with captions, tables, a horizontal rule, a
 * YouTube/Vimeo embed, and the custom "Callout" block (a plain
 * `<div class="c4t-callout">`, which is why `div`/`class` appear in the
 * allow-list at all — nothing else needs either).
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'br',
    'hr',
    'strong',
    'em',
    'u',
    's',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'img',
    'figure',
    'figcaption',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'iframe',
    'div',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder'],
    // `div` carries the Callout's class and the two-up image row's. Note that
    // `figure` is NOT listed here and does not need to be: naming a tag in
    // `allowedClasses` below makes sanitize-html add `class` to that tag's
    // attribute map on its own. Listing it here as well would allow the
    // attribute WITHOUT the value filter, which is the opposite of the intent.
    div: ['class'],
  },

  /**
   * Which class values may survive, per tag.
   *
   * ── Why only `figure`
   *
   * An image's width has to live on the `<figure>`: `img` is allowed exactly
   * `src, alt, title, width, height` and a class on it is dropped silently, so
   * a width expressed there would look right in the editor and be gone after
   * the first save.
   *
   * There is deliberately NO `div` key. Adding one would switch `div` from
   * "any class survives" to "only these survive", and every already-published
   * `<div class="c4t-callout">` whose name was not in the list would lose its
   * styling on the next save — silently, with a 200 and a "Changes saved."
   * Verified both ways against the real options before writing this: with a
   * `figure` key alone, `<div class="c4t-callout">` and even
   * `<div class="random-thing">` pass through untouched.
   *
   * Exact strings only. A glob like `c4t-*` would re-open the hole this
   * closes, on a string the marketing site injects with
   * `dangerouslySetInnerHTML`.
   */
  allowedClasses: {
    figure: ['c4t-w-full', 'c4t-w-wide', 'c4t-w-inline'],
  },
  // The only embeds the editor's YouTube extension can produce — never a
  // caller-supplied arbitrary host.
  allowedIframeHostnames: [
    'www.youtube.com',
    'youtube.com',
    'youtube-nocookie.com',
    'player.vimeo.com',
  ],
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }, true),
  },
}

export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS)
}

/** 200 words/minute is the standard estimate for adult reading speed. */
const WORDS_PER_MINUTE = 200

/**
 * Recomputed server-side on every save from the sanitized plain text — never
 * admin-entered, so it can't drift from the actual article length.
 */
export function computeReadingTimeMinutes(sanitizedHtml: string): number {
  const text = sanitizeHtml(sanitizedHtml, { allowedTags: [], allowedAttributes: {} })
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE))
}

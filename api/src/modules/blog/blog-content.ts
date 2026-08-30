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
    // The Callout node renders as `<div class="c4t-callout">` — the only
    // attribute a `div` is ever allowed to carry.
    div: ['class'],
  },
  // The only embeds the editor's YouTube extension can produce — never a
  // caller-supplied arbitrary host.
  allowedIframeHostnames: ['www.youtube.com', 'youtube.com', 'youtube-nocookie.com', 'player.vimeo.com'],
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

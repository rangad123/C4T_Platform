import { describe, expect, it } from 'vitest'
import { sanitizeContent } from './blog-content.js'

/**
 * The first tests this module has had.
 *
 * It is the only barrier between admin-authored HTML and a marketing page that
 * injects the result with `dangerouslySetInnerHTML`, and every failure mode it
 * has is silent: a disallowed attribute is deleted, a disallowed tag is
 * unwrapped and its children kept. Nothing throws, nothing logs, and the save
 * returns 200 — the damage only shows on the next page load, against content
 * that is already published.
 *
 * So these assert the two directions that matter equally:
 *
 *  - What must KEEP working. A `<div class="c4t-callout">` and a bare `<img>`
 *    already exist in published posts. Every save re-sanitizes the whole body,
 *    so a careless widening of the allow-list rewrites history.
 *  - What must NOT start working. The value filter on figure classes is the
 *    thing standing between a paste and arbitrary class names on the public
 *    site.
 */
describe('sanitizeContent', () => {
  describe('published content must survive untouched', () => {
    it('keeps a callout div and its class', () => {
      const html = '<div class="c4t-callout"><p>Watch out for this.</p></div>'
      expect(sanitizeContent(html)).toBe(html)
    })

    it('leaves any other div class alone', () => {
      // `div` is deliberately absent from `allowedClasses`. Adding it there
      // would strip every class not on the list — including, on the day
      // someone mistypes it, `c4t-callout` on every published post.
      const html = '<div class="something-a-writer-pasted">x</div>'
      expect(sanitizeContent(html)).toBe(html)
    })

    it('keeps a bare image exactly as it is', () => {
      // Guards the figure node's parseHTML: if it ever matched bare `<img>`,
      // opening and re-saving a published post would wrap every image in a
      // figure with an empty caption nobody wrote.
      const html = '<img src="https://cdn.example.com/a.png" alt="A screenshot" />'
      expect(sanitizeContent(html)).toBe(html)
    })

    it('keeps a heading, a list and a blockquote', () => {
      const html =
        '<h2>Before you start</h2><ul><li>One</li></ul><blockquote><p>Quoted.</p></blockquote>'
      expect(sanitizeContent(html)).toBe(html)
    })
  })

  describe('figure width classes', () => {
    it.each(['c4t-w-full', 'c4t-w-wide', 'c4t-w-inline'])('keeps %s', (cls) => {
      const html = `<figure class="${cls}"><img src="https://x.test/a.png" alt="a" /><figcaption>A caption</figcaption></figure>`
      expect(sanitizeContent(html)).toContain(`class="${cls}"`)
    })

    it('drops a class that is not on the list, keeping the one that is', () => {
      const out = sanitizeContent(
        '<figure class="c4t-w-wide anything-else"><img src="https://x.test/a.png" alt="a" /></figure>',
      )
      expect(out).toContain('class="c4t-w-wide"')
      expect(out).not.toContain('anything-else')
    })

    it('drops the class attribute entirely when nothing on it is allowed', () => {
      const out = sanitizeContent(
        '<figure class="totally-made-up"><img src="https://x.test/a.png" alt="a" /></figure>',
      )
      expect(out).toContain('<figure>')
      expect(out).not.toContain('class=')
    })

    it('does not let allowedClasses open any other attribute on figure', () => {
      const out = sanitizeContent(
        '<figure class="c4t-w-wide" onclick="steal()" data-x="1"><img src="https://x.test/a.png" alt="a" /></figure>',
      )
      expect(out).toContain('class="c4t-w-wide"')
      expect(out).not.toContain('onclick')
      expect(out).not.toContain('data-x')
    })

    it('still refuses a class on the image itself', () => {
      // Documents why the width lives on the figure and not the img: this is
      // the exact markup that would look correct in the editor and lose the
      // class on save.
      const out = sanitizeContent('<img src="https://x.test/a.png" alt="a" class="c4t-w-wide" />')
      expect(out).not.toContain('class=')
    })
  })

  describe('the two-up row', () => {
    it('keeps the row and the figures inside it', () => {
      const html =
        '<div class="c4t-two-up">' +
        '<figure class="c4t-w-full"><img src="https://x.test/a.png" alt="a" /><figcaption>Left</figcaption></figure>' +
        '<figure class="c4t-w-full"><img src="https://x.test/b.png" alt="b" /><figcaption>Right</figcaption></figure>' +
        '</div>'
      const out = sanitizeContent(html)
      expect(out).toContain('class="c4t-two-up"')
      expect(out.match(/<figure class="c4t-w-full">/g)).toHaveLength(2)
      expect(out).toContain('<figcaption>Left</figcaption>')
    })
  })

  describe('what must stay out', () => {
    it('removes a script entirely, contents included', () => {
      expect(sanitizeContent('<p>ok</p><script>steal()</script>')).toBe('<p>ok</p>')
    })

    it('removes an event handler from a link but keeps the link', () => {
      const out = sanitizeContent('<a href="https://x.test" onclick="steal()">go</a>')
      expect(out).toContain('href="https://x.test"')
      expect(out).not.toContain('onclick')
    })

    it('refuses a javascript: URL', () => {
      expect(sanitizeContent('<a href="javascript:steal()">go</a>')).not.toContain('javascript:')
    })

    it('refuses a style attribute', () => {
      expect(sanitizeContent('<p style="position:fixed">x</p>')).not.toContain('style=')
    })

    it('unwraps a tag that is not allowed rather than keeping it', () => {
      // Worth asserting because the failure is plausible-looking output, not
      // an error: a template built from an unlisted wrapper degrades to loose
      // children and nobody is told.
      expect(sanitizeContent('<section class="c4t-two-up"><p>x</p></section>')).toBe('<p>x</p>')
    })
  })
})

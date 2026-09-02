/**
 * Starter skeletons for a new blog post.
 *
 * A blank editor is the slowest part of writing, and the four shapes below are
 * the ones this blog actually publishes. Picking one seeds the body with its
 * headings and prompts; the author then writes over them like any other text.
 * Nothing here is enforced — a template is a starting point, not a format.
 *
 * ── Two constraints every template must respect
 *
 * 1. THE SANITIZER. `sanitizeContent` in `api/src/modules/blog/blog-content.ts`
 *    drops anything off its allow-list, silently. Headings are h1–h4 only;
 *    there is no <section>, no <span>, and the only element permitted to carry
 *    a class is <div>. A template using anything else degrades on first save
 *    rather than erroring.
 *
 * 2. THE EDITOR'S PARSER, which is the tighter of the two. Tiptap discards any
 *    node no extension declares a `parseHTML` for, so markup the sanitizer
 *    would happily store still gets flattened the moment the post is reopened.
 *    Everything below is limited to what the configured extensions parse:
 *    headings, paragraphs, lists, blockquote, and `div.c4t-callout`.
 *
 * Prompts are written as real sentences rather than "Lorem" so an unfinished
 * draft reads as unfinished, and the copy rules apply to them like any other
 * text in the product: sentence case, no exclamation marks, no banned words.
 */
export interface BlogTemplate {
  key: string
  label: string
  /** One line, shown under the label in the picker. */
  description: string
  html: string
}

export const BLOG_TEMPLATES: readonly BlogTemplate[] = [
  {
    key: 'how-to',
    label: 'How-to guide',
    description: 'A task broken into ordered steps, with what the reader needs first.',
    html: [
      '<p>Say in one or two sentences what the reader will be able to do by the end, and who this is for.</p>',
      '<h2>Before you start</h2>',
      '<ul><li>What they need access to</li><li>What they should already have set up</li></ul>',
      '<h2>Step 1 — name the first action</h2>',
      '<p>One action per step. Say what to do, then what they should see.</p>',
      '<h2>Step 2 — name the second action</h2>',
      '<p>Describe the step here.</p>',
      '<h2>Step 3 — name the third action</h2>',
      '<p>Describe the step here.</p>',
      '<div class="c4t-callout"><p>Call out the mistake people make here, and how to tell it has happened.</p></div>',
      '<h2>Where to go next</h2>',
      '<p>Point at the next thing worth reading or doing.</p>',
    ].join(''),
  },
  {
    key: 'case-study',
    label: 'Case study',
    description: 'A customer problem, what was done about it, and what changed.',
    html: [
      '<p>One sentence on the customer and the result, so the reader knows whether to keep going.</p>',
      '<h2>The team</h2>',
      '<p>Who they are, what they build, and how they release.</p>',
      '<h2>The problem</h2>',
      '<p>What was going wrong, in their words where possible.</p>',
      '<blockquote><p>A quote from the team about the problem.</p></blockquote>',
      '<h2>What we did</h2>',
      '<p>The approach, and why it suited this team rather than a generic one.</p>',
      '<h2>The results</h2>',
      '<ul><li>A number, with the period it covers</li><li>A second number</li><li>Something that changed but is not a number</li></ul>',
      '<div class="c4t-callout"><p>The one thing another team in the same position should take from this.</p></div>',
    ].join(''),
  },
  {
    key: 'announcement',
    label: 'Announcement',
    description: 'Something shipped: what it is, why it exists, how to get it.',
    html: [
      '<p>What is new, in one sentence, written for someone who has not been following along.</p>',
      '<h2>What it does</h2>',
      '<p>The behaviour, not the implementation.</p>',
      '<h2>Why we built it</h2>',
      '<p>The problem it answers, and who was hitting it.</p>',
      '<h2>How to use it</h2>',
      '<ul><li>Where to find it</li><li>What to try first</li></ul>',
      '<div class="c4t-callout"><p>Anything that changes for people already using the old behaviour.</p></div>',
      '<h2>Availability</h2>',
      '<p>Who has it today, and what is coming next.</p>',
    ].join(''),
  },
  {
    key: 'listicle',
    label: 'Numbered list',
    description: 'A set of points that stand on their own — practices, mistakes, tools.',
    html: [
      '<p>What the list covers and how it was chosen, so it does not read as arbitrary.</p>',
      '<h2>1. Name the first point</h2>',
      '<p>Two or three sentences. Say the point, then why it holds.</p>',
      '<h2>2. Name the second point</h2>',
      '<p>Describe the point here.</p>',
      '<h2>3. Name the third point</h2>',
      '<p>Describe the point here.</p>',
      '<h2>4. Name the fourth point</h2>',
      '<p>Describe the point here.</p>',
      '<h2>5. Name the fifth point</h2>',
      '<p>Describe the point here.</p>',
      '<h2>What to do with this</h2>',
      '<p>The one change worth making after reading.</p>',
    ].join(''),
  },
]

/** The picker's options, with the empty choice that starts from nothing. */
export const BLOG_TEMPLATE_OPTIONS = [
  { value: '', label: 'Blank post' },
  ...BLOG_TEMPLATES.map((t) => ({ value: t.key, label: t.label })),
]

export function blogTemplateHtml(key: string | undefined | null): string | null {
  if (!key) return null
  return BLOG_TEMPLATES.find((t) => t.key === key)?.html ?? null
}

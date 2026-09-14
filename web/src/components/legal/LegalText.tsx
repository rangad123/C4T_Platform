import type { JSX, ReactNode } from 'react'
import type { LegalBlock, LegalDocument, LegalSection } from '@/content'
import { requireRoute } from '@/lib/seo/routes'
import s from './legal.module.css'

/**
 * Renders a numbered legal document — the terms and the privacy policy both go
 * through here, and any later one should too.
 *
 * WHY A RENDERER AND NOT A PAGE PER DOCUMENT. The two documents that exist are
 * shaped identically: numbered sections, some of them headed, holding
 * paragraphs and lists. Writing each as its own JSX page would mean the next
 * legal document either copies 200 lines or looks different from the other
 * two, and a legal page that looks different reads as less official.
 *
 * A DOCUMENT IS NOT AN ARTICLE. The blog renders sanitized HTML through a
 * `:global()` stylesheet; this renders a typed structure, node by node. That is
 * deliberate — the text here is contractual, so there is no HTML to trust, no
 * editor to sanitize, and every clause carries a stable number that has to be
 * addressable. `#3-12` must go on pointing at the same clause a year from now.
 */

/** Section depth from its number — '1' is 1, '1.2' is 2, '1.2.3' is 3. */
function depthOf(section: LegalSection): number {
  return section.number.split('.').length
}

/*
  Email addresses are written into the clause text rather than held as their
  own field — the privacy policy puts one mid-sentence — so they are linked at
  render time. The split keeps the surrounding words as plain text nodes; there
  is no HTML parsing anywhere in this file.
*/
const EMAIL = /([\w.+-]+@[\w-]+\.[\w.-]*\w)/g

function withEmailLinks(text: string): ReactNode[] {
  return text.split(EMAIL).map((part, i) =>
    i % 2 === 1 ? (
      <a key={`${part}-${String(i)}`} href={`mailto:${part}`}>
        {part}
      </a>
    ) : (
      part
    ),
  )
}

function Block({ block }: { block: LegalBlock }): JSX.Element {
  if (block.kind === 'list') {
    const List = block.ordered ? 'ol' : 'ul'
    return (
      <List className={block.ordered ? s.orderedList : s.bulletList}>
        {block.items.map((item) => (
          <li key={item}>{withEmailLinks(item)}</li>
        ))}
      </List>
    )
  }
  return <p className={s.paragraph}>{withEmailLinks(block.text)}</p>
}

/**
 * A headed section. The number is its own link so a clause can be cited by URL
 * — the same affordance a printed contract gets from its margin numbering.
 */
function Heading({ section }: { section: LegalSection }): JSX.Element {
  const depth = depthOf(section)
  const Tag = depth === 1 ? 'h2' : depth === 2 ? 'h3' : 'h4'
  const type = depth === 1 ? 'c4t-heading-lg' : depth === 2 ? 'c4t-heading-md' : 'c4t-heading-sm'

  /*
    A part heading already has the rule and the padding of `.part` above it; a
    sub-heading has nothing, and butts straight up against the list or
    paragraph that ends the section before it.
  */
  const spacing = depth === 1 ? '' : ` ${s.subheading}`

  return (
    <Tag className={`${type} ${s.heading}${spacing}`}>
      <a href={`#${section.id}`} className={s.headingNumber}>
        {section.number}
      </a>
      {section.title}
    </Tag>
  )
}

export function LegalText({ document }: { document: LegalDocument }): JSX.Element {
  const route = requireRoute(document.slug)
  const contents = document.sections.filter((section) => depthOf(section) === 1)

  return (
    // The marketing layout owns <main id="main">; this must not nest another.
    <div
      className="c4t-container"
      style={{ maxWidth: 'var(--container-prose)', paddingBottom: 'var(--space-13)' }}
    >
      <header className={s.header}>
        <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
          Legal
        </p>
        <h1 className="c4t-display-md" style={{ marginBlock: 'var(--space-4) var(--space-5)' }}>
          {route.title}
        </h1>
        <p className="c4t-body-lg" style={{ color: 'var(--text-secondary)' }}>
          {route.description}
        </p>
      </header>

      {/* Four to five entries on either document — long enough to be worth a
          map of, short enough that it does not need to collapse. */}
      <nav className={s.contents} aria-label="Contents">
        <p className="c4t-eyebrow" style={{ color: 'var(--text-muted)' }}>
          Contents
        </p>
        <ol className={s.contentsList}>
          {contents.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>
                <span className={s.contentsNumber}>{section.number}</span>
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {document.preamble ? (
        <div className={s.preamble}>
          {document.preamble.map((block, i) => (
            <Block key={`preamble-${String(i)}`} block={block} />
          ))}
        </div>
      ) : null}

      {document.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className={depthOf(section) === 1 ? s.part : undefined}
        >
          {section.title ? (
            <Heading section={section} />
          ) : (
            // An unheaded clause: the number sits in the margin, as it would on
            // paper, and stays a link so the clause is still citable.
            <div className={s.clause}>
              <a href={`#${section.id}`} className={s.clauseNumber}>
                {section.number}
              </a>
              <div>
                {section.blocks.map((block, i) => (
                  <Block key={`${section.id}-${String(i)}`} block={block} />
                ))}
              </div>
            </div>
          )}

          {section.title
            ? section.blocks.map((block, i) => (
                <Block key={`${section.id}-${String(i)}`} block={block} />
              ))
            : null}
        </section>
      ))}
    </div>
  )
}

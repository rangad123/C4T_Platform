import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { buildPublicPostsWhere } from '../../src/modules/blog/blog-posts.service.js'

const base = { page: 1, limit: 12 }

function clauses(where: Prisma.BlogPostWhereInput): Prisma.BlogPostWhereInput[] {
  return where.AND as Prisma.BlogPostWhereInput[]
}

describe('buildPublicPostsWhere', () => {
  it('always starts with the published-only rule', () => {
    const [visible] = clauses(buildPublicPostsWhere(base))
    expect(visible).toMatchObject({ deletedAt: null })
    expect(visible?.OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'PUBLISHED' })]),
    )
  })

  it('keeps the published-only rule when a search is added', () => {
    // A top-level OR from the search used to REPLACE the visibility OR, so any
    // search returned drafts and archived posts. Every OR must live inside its
    // own AND entry instead.
    const where = buildPublicPostsWhere({ ...base, search: 'kittens' })

    expect(where.OR).toBeUndefined()
    const [visible, search] = clauses(where)
    expect(visible?.OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'PUBLISHED' })]),
    )
    expect(search?.OR).toEqual(
      expect.arrayContaining([{ title: { contains: 'kittens', mode: 'insensitive' } }]),
    )
  })

  it('adds no top-level OR for any combination of filters', () => {
    const where = buildPublicPostsWhere({
      ...base,
      search: 'x',
      collection: 'articles',
      category: 'ai',
      tag: 'agentic',
    })
    expect(where.OR).toBeUndefined()
    expect(clauses(where)).toHaveLength(3)
  })

  it('selects case studies by the Case Study category or a case-study tag', () => {
    const [, collection] = clauses(buildPublicPostsWhere({ ...base, collection: 'case-studies' }))

    expect(collection?.OR).toEqual([
      { category: { slug: 'case-study' } },
      { tags: { some: { tag: { slug: { in: ['case-study', 'case-studies'] } } } } },
    ])
  })

  it('selects articles without negating the case-study filter', () => {
    // NOT (category_id IN (...)) is NULL for a post with no category, which
    // would drop every uncategorised post from the articles. The filter has to
    // say "no category, or a different one" explicitly.
    const [, collection] = clauses(buildPublicPostsWhere({ ...base, collection: 'articles' }))
    const serialised = JSON.stringify(collection)

    expect(serialised).not.toContain('"NOT"')
    expect(serialised).toContain('"categoryId":null')
    expect(collection).toEqual({
      AND: [
        { OR: [{ categoryId: null }, { category: { slug: { not: 'case-study' } } }] },
        { tags: { none: { tag: { slug: { in: ['case-study', 'case-studies'] } } } } },
      ],
    })
  })

  it('applies no collection filter when none is asked for', () => {
    expect(clauses(buildPublicPostsWhere(base))).toHaveLength(1)
  })

  it('still passes the simple filters straight through', () => {
    const where = buildPublicPostsWhere({
      ...base,
      category: 'ai',
      tag: 'agentic',
      excludeId: 'ckx0000000000000000000000',
    })
    expect(where).toMatchObject({
      category: { slug: 'ai' },
      tags: { some: { tag: { slug: 'agentic' } } },
      id: { not: 'ckx0000000000000000000000' },
    })
  })
})

'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Icon } from '../core/Icon'

interface SearchResult {
  slug: string
  title: string
  excerpt: string | null
}

/**
 * Progressive enhancement: a real `<form method="GET">` that posts to
 * `/company/blog?search=...` — works with no JavaScript, and is the fallback
 * path a submit or Enter always takes. On top of that, a debounced fetch
 * against `/company/blog/search` (a same-origin proxy, never the API
 * directly) renders an inline type-ahead dropdown, purely as a convenience.
 */
export function BlogSearchBox({ defaultValue }: { defaultValue?: string }) {
  const [query, setQuery] = useState(defaultValue ?? '')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) return

    const timer = setTimeout(() => {
      fetch(`/company/blog/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => (res.ok ? res.json() : { results: [] }))
        .then((body: { results: SearchResult[] }) => setResults(body.results))
        .catch(() => setResults(null))
    }, 300)

    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', maxWidth: 360 }}>
      <form method="GET" action="/company/blog" role="search">
        <span style={{ position: 'relative', display: 'block' }}>
          <Icon
            name="search"
            size={18}
            style={{
              position: 'absolute',
              left: 14,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            name="search"
            value={query}
            onChange={(event) => {
              const value = event.target.value
              setQuery(value)
              setOpen(true)
              if (!value.trim()) setResults(null)
            }}
            onFocus={() => setOpen(true)}
            placeholder="Search the blog"
            aria-label="Search the blog"
            className="c4t-input"
            style={{
              width: '100%',
              minHeight: 44,
              padding: '10px 14px 10px 42px',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--type-body-sm-size)',
              color: 'var(--text-primary)',
              background: 'var(--surface-canvas)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-input)',
            }}
          />
        </span>
      </form>

      {open && query.trim() && results ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            padding: 'var(--space-2)',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-md)',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {results.length === 0 ? (
            <span
              style={{
                padding: 'var(--space-3) var(--space-4)',
                color: 'var(--text-muted)',
                fontSize: 'var(--type-body-sm-size)',
              }}
            >
              No posts match &quot;{query.trim()}&quot;.
            </span>
          ) : (
            results.map((result) => (
              <Link
                key={result.slug}
                href={`/company/blog/${result.slug}`}
                onClick={() => setOpen(false)}
                style={{
                  display: 'block',
                  padding: 'var(--space-3) var(--space-4)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  textDecoration: 'none',
                  fontSize: 'var(--type-body-sm-size)',
                }}
              >
                {result.title}
              </Link>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

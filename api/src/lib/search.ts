/**
 * Splits a free-text search box into the terms a person meant by it.
 *
 * ── The bug this exists to stop
 *
 * Every list in this API matched the WHOLE search string against each column
 * on its own: `firstName contains "devi madduri"`, `lastName contains "devi
 * madduri"`, and so on. No column holds a full name, so typing one — the most
 * obvious thing to type into a box labelled Search — matched nothing, on a
 * page that was plainly showing that person a moment earlier. Only a single
 * word that happened to sit in one column ever worked.
 *
 * Splitting on whitespace and requiring EVERY term to match SOME column fixes
 * it, and fixes it in both directions: "madduri devi" and "devi madduri" both
 * find the same person, because neither order is a fact about the data.
 *
 * ── Why a cap
 *
 * Each term becomes another AND clause, so a pasted paragraph would become a
 * query with a hundred joins. Six is well past any real name or address and
 * far short of anything expensive; extra words are dropped rather than
 * refused, because a search box that rejects input is worse than one that
 * ignores the tail of it.
 */
export function searchTerms(search: string | undefined | null): string[] {
  if (!search) return []
  return search.trim().split(/\s+/).filter(Boolean).slice(0, 6)
}

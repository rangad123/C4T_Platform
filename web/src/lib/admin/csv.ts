/**
 * Split a comma-separated input into a clean array.
 *
 * Empty strings, stray whitespace, and a single trailing comma would all
 * produce `['']` with a naive split, which the API then rejects as an empty
 * string. Trim each piece, drop empties, and return what the API actually
 * wants — a list of values, possibly empty.
 */
export function parseCommaList(value: string): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
}

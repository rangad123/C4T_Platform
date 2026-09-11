import { ISO_639_1_LANGUAGES } from '../../../src/lib/languages.js'

/**
 * Legacy language names → ISO 639-1 codes.
 *
 * `builds.build_languages` and `projects.project_test_lang` are free text and
 * hold spelled-out names — "English,Hindi" — while `targetLanguages` is a code
 * list everywhere else in the platform: the catalog serves codes, the wizard's
 * picker emits codes, and `updateBuildSchema` refuses anything that is not
 * exactly two characters. Copying the names across left 37 builds carrying
 * values no picker would show as selected and the update schema rejects.
 *
 * Anything with no ISO match is dropped by `toIsoLanguages` and reported by
 * the caller rather than guessed at.
 */

let index: Map<string, string> | null = null

function buildIndex(): Map<string, string> {
  if (index) return index
  const map = new Map<string, string>()
  for (const { code, name } of ISO_639_1_LANGUAGES) {
    map.set(name.toLowerCase(), code)
    /*
      ISO names carry qualifiers — "Sotho, Southern", "Panjabi; Punjabi" — so
      each leading segment is indexed too, which is the form the legacy data
      actually uses.
    */
    const head = name.split(/[,;]/)[0]?.trim().toLowerCase()
    if (head) map.set(head, code)
  }
  /*
    Spellings the legacy free-text column uses that ISO does not. Each is a
    named language, not a guess: Mandarin is the spoken form of Chinese,
    Sesotho is Southern Sotho, and "Gujrati" is Gujarati misspelled.
  */
  for (const [alias, code] of Object.entries({
    mandarin: 'zh',
    sesotho: 'st',
    gujrati: 'gu',
    odia: 'or',
    oriya: 'or',
    malay: 'ms',
    filipino: 'tl',
    tagalog: 'tl',
    farsi: 'fa',
    persian: 'fa',
    'brazilian portuguese': 'pt',
    flemish: 'nl',
  })) {
    map.set(alias, code)
  }
  index = map
  return map
}

const VALID: ReadonlySet<string> = new Set(ISO_639_1_LANGUAGES.map((l) => l.code))

/** One value → its ISO 639-1 code, or null when nothing matches. */
export function toIsoLanguage(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  // Already a code — keep it as it is.
  if (value.length === 2 && VALID.has(value.toLowerCase())) return value.toLowerCase()
  return buildIndex().get(value.toLowerCase()) ?? null
}

/**
 * A legacy list → deduplicated ISO codes, plus whatever could not be mapped.
 *
 * The unmapped names come back rather than being swallowed so a loader can
 * report them: a language list that is quietly short is worse than one that
 * is obviously stale.
 */
export function toIsoLanguages(values: readonly string[]): {
  codes: string[]
  unmapped: string[]
} {
  const codes: string[] = []
  const unmapped: string[] = []
  for (const value of values) {
    const code = toIsoLanguage(value)
    if (!code) {
      if (value.trim()) unmapped.push(value.trim())
    } else if (!codes.includes(code)) {
      codes.push(code)
    }
  }
  return { codes, unmapped }
}

/**
 * Typed reads from a `FormData`.
 *
 * `FormData.get()` returns `FormDataEntryValue | null` — that is
 * `string | File | null`. Passing the result straight to `String()` compiles,
 * but a `File` stringifies to `"[object File]"`, which then sails through
 * validation as a non-empty string. On a text field that is merely wrong; on
 * a field that names a record id it is a bug that only shows up when someone
 * posts a multipart body by hand.
 *
 * These helpers narrow explicitly: a `File` is treated as absent, because a
 * file was never what the caller asked for.
 */

/** Reads a text field. Returns '' when absent, empty, or a File. */
export function formString(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === 'string' ? value : ''
}

/** Reads a trimmed text field. Returns '' when absent, empty, or a File. */
export function formTrimmed(formData: FormData, key: string): string {
  return formString(formData, key).trim()
}

/**
 * Reads every value for a repeated field — a checkbox group sharing one
 * `name`, most commonly. Non-string entries (a stray `File`) are dropped
 * rather than stringified, for the same reason `formString` narrows.
 */
export function formStringArray(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((v): v is string => typeof v === 'string')
}

/**
 * Reads a list that may arrive in either of two shapes.
 *
 * `MultiSelect` emits one hidden input per chosen value; the text inputs it
 * replaced emitted a single comma-separated string. Both shapes are accepted
 * so a form can be converted on its own, without its Server Action having to
 * change in the same commit — and so a form that has not been converted yet
 * keeps working.
 *
 * The ambiguous case is one entry containing a comma, which is read as a
 * comma-separated list. That is right for the fields this serves — language
 * codes, browser and OS names, platform targets — none of which contain
 * commas. It would be wrong for free text, which is why this is not the
 * general-purpose reader.
 */
export function formList(formData: FormData, key: string): string[] {
  const entries = formStringArray(formData, key)
  const parts = entries.length > 1 ? entries : (entries[0] ?? '').split(',')
  return parts.map((part) => part.trim()).filter(Boolean)
}

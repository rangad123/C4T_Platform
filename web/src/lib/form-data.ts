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

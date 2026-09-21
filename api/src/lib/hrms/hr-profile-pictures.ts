import path from 'node:path'

/**
 * Helpers for putting profile pictures from another system onto employees.
 * Pure, so what decides "is this an image, and which file is it" can be tested
 * without a folder of real pictures.
 */

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The image type for a file name, or null if it is not a picture format the app takes. */
export function pictureMime(fileName: string): string | null {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? null
}

/**
 * The file in a folder that matches the name the old system recorded.
 *
 * The exact name wins. Failing that, the same name in a different case:
 * pictures copied out of a Windows folder or a hosting file manager come back
 * as `Admin.JPG` when the database says `admin.jpg`, and treating that as
 * "missing" would drop a picture that is sitting right there.
 */
export function findPictureFile(available: readonly string[], wanted: string): string | null {
  const exact = available.find((name) => name === wanted)
  if (exact) return exact
  const lower = wanted.toLowerCase()
  return available.find((name) => name.toLowerCase() === lower) ?? null
}

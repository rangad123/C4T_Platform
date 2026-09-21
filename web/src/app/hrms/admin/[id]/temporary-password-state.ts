/**
 * What the temporary-password form is showing. A separate file because the
 * Server Action module may only export functions, and both that action and the
 * client form need the same shape.
 */
export type TemporaryPasswordState =
  { status: 'idle' } | { status: 'done'; password: string } | { status: 'error'; message: string }

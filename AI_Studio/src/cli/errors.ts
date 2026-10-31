/** Exit codes of `ai-test run`. Documented in docs/features/ci.md; pipelines rely on them. */
export const EXIT = { OK: 0, GATE_FAILED: 1, ERROR: 2 } as const;

/** The command line itself is wrong (unknown flag, missing value...). Exit code 2. */
export class UsageError extends Error {}

/** The run could not be carried out (server unreachable, job failed, nothing to run...). Exit code 2. */
export class InfraError extends Error {}

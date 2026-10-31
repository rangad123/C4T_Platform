/** Types for deploy trigger tokens (the API shape lives in src/platform/routes/triggers.ts). */
export interface TriggerToken {
    id: string;
    label: string | null;
    /** Last four characters of the token, to tell tokens apart. The token itself is shown once, at creation. */
    hint: string;
    allowUrl: boolean;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    /** The runbook this token starts instead of a plain re-run (see features/runbooks). */
    runbookId?: string | null;
    runbookName?: string | null;
}

export interface TriggerList {
    minSecondsBetweenRuns: number;
    tokens: TriggerToken[];
}

/** What a pipeline runs, shown right after a token is created (the only moment the token is known). */
export function curlExample(origin: string, token: string): string {
    return [
        `curl -X POST "${origin}/api/triggers/${token}/run" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '{"commit":"'"$GIT_COMMIT"'","environment":"staging"}'`,
    ].join("\n");
}

/** Types for what the live API changed between two runs (GET /projects/:id/api-changes). */

export interface ApiChange {
    breaking: boolean;
    /** e.g. "GET /api/users/{}" */
    operation: string;
    message: string;
}

export interface ApiChanges {
    from: { jobId: string; at: string } | null;
    to: { jobId: string; at: string } | null;
    breaking: ApiChange[];
    nonBreaking: ApiChange[];
    message?: string;
}

/** Changes shown before "Show all". */
export const SHOWN = 6;

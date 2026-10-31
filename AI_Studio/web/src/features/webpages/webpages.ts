/**
 * Test files (for upload steps) and the test data reset before a run: the shapes the platform answers with and the plain sentences made
 * from them. No React here, so a plain test can run it. Platform side: src/platform/routes/web-pages.ts.
 */
import { ApiError, csrfHeader, getKey } from "../../api";

export interface TestFileRow {
    name: string;
    size: number;
    contentType: string;
    createdAt: string;
    usedBy: string[];
}
export interface TestFilesAnswer {
    files: TestFileRow[];
    missing: Array<{ name: string; usedBy: string[] }>;
    limits: { fileBytes: number; files: number; totalBytes: number; types: string[] };
}

export interface ResetHookRow {
    environment: string;
    enabled: boolean;
    method: string;
    url: string;
    headerNames: string[];
    expectedStatus: number;
    last: { ok: boolean; message: string; at: string } | null;
    updatedAt: string;
}
export interface ResetAnswer {
    hooks: ResetHookRow[];
    methods: string[];
    limits: { headers: number; headerValue: number; url: number; timeoutMs: number };
}
export interface ResetOutcome {
    ok: boolean;
    status?: number;
    ms: number;
    message: string;
}

/** The part of the Run panel's sentence about the reset, or "" when none is switched on for where the run goes. */
export function resetSentence(hooks: ResetHookRow[] | undefined, environment: string): string {
    const h = (hooks ?? []).find((x) => x.environment === environment);
    if (!h || !h.enabled) return "";
    return `First the test data is reset (${h.method} ${h.url}); if that fails, no test runs.`;
}

/** Sends a file's bytes as the raw request body (it is not wrapped in JSON). */
export async function uploadTestFile(projectId: string, file: File, name = file.name): Promise<TestFileRow> {
    let res: Response;
    try {
        res = await fetch(`/api/projects/${projectId}/test-files?name=${encodeURIComponent(name)}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream", ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader("POST") },
            body: file,
        });
    } catch {
        throw new ApiError(0, "Could not reach the platform server");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string } & TestFileRow;
    if (!res.ok) throw new ApiError(res.status, data.error || (res.status === 413 ? "The file is too large." : res.statusText));
    return data;
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

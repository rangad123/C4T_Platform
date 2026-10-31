/** Types and wording for "What the page did" (failure evidence). The answer is computed by the platform; this only words it. */

export interface EvidenceRequest {
    t: number;
    step: number;
    method: string;
    type: string;
    path: string;
    host?: string;
    status?: number;
    ms?: number;
    size?: number;
    failed?: string;
    aborted?: boolean;
    pending?: boolean;
}

export interface EvidenceLine {
    t: number;
    step: number;
    type: string;
    text: string;
    loc?: string;
}

export interface EvidenceAnswer {
    available: boolean;
    message?: string;
    execution?: { id: string; status: string; startedAt: string; failedStep?: number };
    summary?: { sentence: string; requests: number; failedRequests: number; cancelledRequests: number; consoleErrors: number; uncaughtErrors: number };
    highlights?: { failed: EvidenceRequest[]; slow: EvidenceRequest[]; errors: EvidenceLine[] };
    evidence?: { durationMs: number; counts: { requests: number; requestsKept: number; console: number; consoleKept: number }; requests: EvidenceRequest[]; console: EvidenceLine[] };
}

export const isFailed = (r: EvidenceRequest) => (Boolean(r.failed) && !r.aborted) || (r.status !== undefined && r.status >= 400);

/** "POST /api/cart" (without the query; another site's name is kept). */
export const requestName = (r: EvidenceRequest) => `${r.method} ${r.host ?? ""}${r.path.split("?")[0]}`;

/** What happened to a request, in words. */
export function requestResult(r: EvidenceRequest): { text: string; tone: "danger" | "warning" | "neutral" | "info" | "success" } {
    if (r.aborted) return { text: "Cancelled", tone: "neutral" };
    if (r.failed) {
        const why = /REFUSED/i.test(r.failed) ? "Could not connect" : /NAME_NOT_RESOLVED/i.test(r.failed) ? "Server not found" : /TIMED_OUT/i.test(r.failed) ? "Timed out" : "Failed";
        return { text: why, tone: "danger" };
    }
    if (r.status === undefined) return { text: "No answer yet", tone: "info" };
    if (r.status >= 500) return { text: `Answered ${r.status}`, tone: "danger" };
    if (r.status >= 400) return { text: `Answered ${r.status}`, tone: "warning" };
    return { text: `Answered ${r.status}`, tone: "success" };
}

/** Where in the test a request or console line happened, relative to the step that failed. */
export function whenText(step: number, failedStep?: number): string {
    if (step === 0) return "Before the first step";
    if (failedStep !== undefined && step === failedStep) return `During step ${step}, the one that failed`;
    if (failedStep !== undefined && step === failedStep - 1) return `During step ${step}, just before it failed`;
    return `During step ${step}`;
}

export const isNearFailure = (step: number, failedStep?: number) => failedStep !== undefined && (step === failedStep || step === failedStep - 1);

export const LINE_TYPE: Record<string, string> = { error: "Error", pageerror: "Uncaught exception", warning: "Warning", log: "Log", info: "Info", debug: "Debug" };

export function sizeText(bytes?: number): string {
    if (bytes === undefined) return "";
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

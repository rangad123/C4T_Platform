/**
 * What the evidence says, in plain words and without any model: counts, the requests and console lines that most likely matter,
 * and a one-sentence summary ("2 requests failed: POST /api/cart answered 500 and GET /api/x answered 404; 1 console error;
 * the page made 41 requests"). The same text goes on the test page, into issues and into the shareable report.
 */
import type { Evidence, EvidenceConsoleLine, EvidenceRequest } from "./model.js";

/** A request slower than this is worth a mention. */
export const SLOW_REQUEST_MS = 2000;

export interface EvidenceSummary {
    sentence: string;
    requests: number;
    failedRequests: number;
    cancelledRequests: number;
    consoleErrors: number;
    uncaughtErrors: number;
}

export interface EvidenceHighlights {
    /** Failed or error answers, those around the failing step first, then 5xx before network errors before 4xx. */
    failed: EvidenceRequest[];
    slow: EvidenceRequest[];
    /** Console errors and uncaught exceptions, those around the failing step first. */
    errors: EvidenceConsoleLine[];
    /** What happened during the failing step and the one before it (the end of each list, at most 8). */
    nearFailure: { requests: EvidenceRequest[]; console: EvidenceConsoleLine[] } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const isFailedRequest = (r: EvidenceRequest) => (Boolean(r.failed) && !r.aborted) || (r.status !== undefined && r.status >= 400);
export const isConsoleError = (l: EvidenceConsoleLine) => l.type === "error";
export const isUncaught = (l: EvidenceConsoleLine) => l.type === "pageerror";

/** "POST /api/cart" (the address without its query; another site's name is kept). */
export function requestLabel(r: EvidenceRequest): string {
    return `${r.method} ${r.host ? r.host : ""}${r.path.split("?")[0]}`;
}

/** Why a request failed, in words ("answered 500", "could not connect"). */
export function requestProblem(r: EvidenceRequest): string {
    if (r.status !== undefined && r.status >= 400) return `answered ${r.status}`;
    const why = r.failed ?? "";
    if (/REFUSED/i.test(why)) return "could not connect";
    if (/NAME_NOT_RESOLVED|ENOTFOUND/i.test(why)) return "could not find the server";
    if (/TIMED_OUT|TIMEOUT/i.test(why)) return "timed out";
    if (/RESET|CLOSED|EMPTY_RESPONSE/i.test(why)) return "lost the connection";
    if (/CERT|SSL/i.test(why)) return "had a certificate problem";
    return "failed";
}

const severityRank = (r: EvidenceRequest) => (r.status !== undefined && r.status >= 500 ? 0 : r.status === undefined ? 1 : 2);

/** 1-based number of the step that failed, from a 0-based index (or -1 / undefined when unknown). */
export const stepNumber = (failedIndex: number | undefined | null) => (failedIndex !== undefined && failedIndex !== null && failedIndex >= 0 ? failedIndex + 1 : undefined);

/** Around the failing step: the step itself and the one before. */
const near = (step: number, failedStep: number | undefined) => failedStep !== undefined && (step === failedStep || step === failedStep - 1);

export function highlights(ev: Evidence, failedStep?: number): EvidenceHighlights {
    const order = (a: EvidenceRequest, b: EvidenceRequest) => Number(near(b.step, failedStep)) - Number(near(a.step, failedStep)) || severityRank(a) - severityRank(b) || a.t - b.t;
    const failed = ev.requests.filter(isFailedRequest).sort(order);
    const slow = ev.requests.filter((r) => !isFailedRequest(r) && (r.ms ?? 0) >= SLOW_REQUEST_MS).sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5);
    const errors = ev.console.filter((l) => isConsoleError(l) || isUncaught(l)).sort((a, b) => Number(near(b.step, failedStep)) - Number(near(a.step, failedStep)) || a.t - b.t);
    const nearFailure =
        failedStep === undefined
            ? null
            : {
                  requests: ev.requests.filter((r) => near(r.step, failedStep)).slice(-8),
                  console: ev.console.filter((l) => near(l.step, failedStep)).slice(-8),
              };
    return { failed, slow, errors, nearFailure };
}

export function summarize(ev: Evidence, failedStep?: number): EvidenceSummary {
    const h = highlights(ev, failedStep);
    const cancelled = ev.requests.filter((r) => r.aborted).length;
    const consoleErrors = ev.console.filter(isConsoleError).length;
    const uncaught = ev.console.filter(isUncaught).length;
    const total = ev.counts.requests;

    const parts: string[] = [];
    if (h.failed.length) {
        const shown = h.failed.slice(0, 2).map((r) => `${requestLabel(r)} ${requestProblem(r)}`);
        const more = h.failed.length - shown.length;
        const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(" and ");
        parts.push(`${plural(h.failed.length, "request")} failed: ${list}`);
    }
    if (uncaught) {
        const first = ev.console.find(isUncaught)!;
        parts.push(`${plural(uncaught, "uncaught exception")}: “${clip(first.text.replace(/\s+/g, " ").trim(), 80)}”`);
    }
    if (consoleErrors) parts.push(plural(consoleErrors, "console error"));
    if (cancelled) parts.push(`${plural(cancelled, "request")} ${cancelled === 1 ? "was" : "were"} cancelled`);

    let sentence: string;
    if (parts.length) {
        parts.push(`the page made ${plural(total, "request")}`);
        sentence = `${parts.join("; ")}.`;
    } else if (total === 0 && ev.counts.console === 0) {
        sentence = "The page made no requests and wrote nothing to the console.";
    } else {
        sentence = `No failed requests or console errors were recorded; the page made ${plural(total, "request")}.`;
    }
    sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    if (ev.counts.requests > ev.counts.requestsKept) sentence += ` Only ${ev.counts.requestsKept} of them were kept, the most useful ones.`;
    return { sentence, requests: total, failedRequests: h.failed.length, cancelledRequests: cancelled, consoleErrors, uncaughtErrors: uncaught };
}

/**
 * Round 20 (SIGN): the uploaded API document's operations during an assessment. Only GET operations without required parameters are
 * requested (../api-document.ts decides), one plain GET each, through the scope guard: in scope, not excluded, not a sensitive workflow,
 * not a sign-out address, within the request budget. No value from the document is ever sent (no examples, no bodies). The answers are
 * judged like the API answers the pages fetched (cookies, information disclosure, and up to three for the CORS look).
 */
import { normalizeApiPath } from "../../engine/discovery/network.js";
import { API_DOCUMENT_MAX_REQUESTS, planOperations, readApiDocument } from "../api-document.js";
import { DISCOVERY_CAPS, isExcluded } from "./discover.js";
import { RefusedError, RequestCapError, type DiscoveryResult, type Guard } from "./types.js";

const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

/**
 * Requests the document's requestable operations and records what was and was not requested in `d.apiDocument`. Throws
 * RequestCapError when the budget runs out (what was done until then is recorded) and when the assessment is cancelled.
 */
export async function requestDocumentOperations(
    guard: Guard,
    document: { text: string; fileName: string },
    app: { targetUrl: string; excludedPaths: string[] },
    d: DiscoveryResult,
    signal: AbortSignal,
    onProgress?: (done: number, total: number, path: string) => void,
): Promise<void> {
    const record: NonNullable<DiscoveryResult["apiDocument"]> = { fileName: document.fileName, operations: 0, requested: [], notRequested: { notGet: 0, needValues: 0, signOut: 0, refused: [], overLimit: 0 } };
    d.apiDocument = record;
    let plan;
    try {
        plan = planOperations(readApiDocument(document.text, document.fileName).doc, app.targetUrl);
    } catch (e) {
        record.notRequested.refused.push({ path: "(the document)", reason: `It could not be read: ${first(e)}` });
        return;
    }
    record.operations = plan.total;
    const startOrigin = new URL(app.targetUrl).origin;
    const toRequest = plan.operations.filter((o) => o.request && o.url);
    for (const o of plan.operations) {
        if (o.kind === "not-get") record.notRequested.notGet++;
        else if (o.kind === "needs-values" || o.kind === "bad-path") record.notRequested.needValues++;
        else if (o.kind === "sign-out") record.notRequested.signOut++;
    }
    let sent = 0;
    for (const [i, o] of toRequest.entries()) {
        if (signal.aborted) throw new Error("Assessment cancelled");
        const url = o.url!;
        if (sent >= API_DOCUMENT_MAX_REQUESTS) {
            record.notRequested.overLimit++;
            continue;
        }
        onProgress?.(i, toRequest.length, o.path);
        const refusal = isExcluded(url, app.excludedPaths) ? "It is under an excluded path or a sensitive workflow." : await guard.refusal(url);
        if (refusal) {
            if (record.notRequested.refused.length < 50) record.notRequested.refused.push({ path: o.path, reason: refusal });
            continue;
        }
        try {
            sent++;
            const a = await guard.fetch(url, { method: "GET", headers: { accept: "application/json, application/problem+json;q=0.9, */*;q=0.5" }, maxBytes: 64_000, signal });
            record.requested.push({ path: o.path, status: a.status });
            if (d.apiAnswers.length < DISCOVERY_CAPS.apiAnswers + API_DOCUMENT_MAX_REQUESTS) {
                d.apiAnswers.push({ status: a.status, headers: a.headers, text: a.text.slice(0, DISCOVERY_CAPS.apiText), url: a.url, setCookies: a.setCookies, sent: { accept: "application/json" } });
            }
            const u = new URL(url);
            const key = `GET ${u.origin === startOrigin ? "" : u.origin}${normalizeApiPath(u.pathname)}`;
            if (!d.apiCalls.includes(key) && d.apiCalls.length < DISCOVERY_CAPS.apiCalls) d.apiCalls.push(key);
        } catch (e) {
            if (e instanceof RequestCapError || signal.aborted) throw e;
            if (record.notRequested.refused.length < 50) record.notRequested.refused.push({ path: o.path, reason: e instanceof RefusedError ? e.reason : `It could not be requested: ${first(e)}` });
        }
    }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The coverage sentence: "The API document lists 34 operations; 12 GET operations were requested read-only, the rest were not called (…)." */
export function apiDocumentCoverage(x: NonNullable<DiscoveryResult["apiDocument"]>): string {
    const n = x.notRequested;
    const parts = [
        n.notGet ? `${n.notGet} could change data or are not GET` : "",
        n.needValues ? `${n.needValues} need values the assessment does not invent` : "",
        n.signOut ? `${n.signOut} look like sign-out addresses` : "",
        n.refused.length ? `${n.refused.length} are excluded, sensitive, outside the scope or could not be requested, for example ${n.refused[0]!.path}` : "",
        n.overLimit ? `${n.overLimit} over the limit of ${API_DOCUMENT_MAX_REQUESTS} per assessment` : "",
    ].filter(Boolean);
    const verb = x.requested.length === 1 ? "was" : "were";
    if (x.operations > 0 && x.requested.length === x.operations) return `The API document “${x.fileName}” lists ${plural(x.operations, "operation")}; each is a GET without required parameters and ${verb} requested read-only.`;
    return `The API document “${x.fileName}” lists ${plural(x.operations, "operation")}; ${plural(x.requested.length, "GET operation")} ${verb} requested read-only, the rest were not called${parts.length ? ` (${parts.join("; ")})` : ""}.`;
}

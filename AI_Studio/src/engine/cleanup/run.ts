/**
 * Removing what the tests created: collect the records a run reported, then send the recorded DELETEs.
 *
 * Rules that make this safe (each is covered by tests/cleanup.test.ts):
 *  - only records a script captured in THIS run are ever deleted: nothing is listed, guessed or looked up;
 *  - one DELETE per record, newest first, one at a time, each with a timeout; 404 and 410 mean "already gone";
 *  - the same credentials the tests used (the run's API token or auth header);
 *  - only the application's own address: the delete goes to the run's API origin, through the same outbound guard as every
 *    other request, and redirects are never followed (they would carry the credentials somewhere else);
 *  - a failure never changes a test's result and never fails the job: it is recorded and described in plain words;
 *  - never anything but ids and paths are kept; an answer's body is not even read.
 */
import type { EngineContext } from "../context.js";
import type { TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";
import { byCreation, countItems, planItems, summaryLine, type CreatedLine, type FinishedItem, type LedgerItem } from "./ledger.js";

export const DELETE_TIMEOUT_MS = 10_000;

/** What a host hands a run to switch test-data cleanup on: enabled=false lists what the tests created but removes nothing. */
export interface CleanupRequest {
    enabled: boolean;
    /** Outbound guard for every DELETE (the platform passes assertAllowedTarget). */
    guard?: (url: string) => Promise<void>;
    /** The fetch that sends each DELETE (the platform passes guardedFetch, which connects only to a checked address); default: fetch. */
    fetch?: typeof fetch;
}

/** Credentials a run's scripts send (the same two variables the script reads: API_TOKEN, API_AUTH_HEADER). */
export interface CleanupCredentials {
    apiToken?: string;
    /** "Header-Name: value" */
    apiAuthHeader?: string;
}

export function cleanupHeaders(c: CleanupCredentials | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    if (c?.apiToken) headers["Authorization"] = `Bearer ${c.apiToken}`;
    if (c?.apiAuthHeader) {
        const i = c.apiAuthHeader.indexOf(":");
        if (i > 0) headers[c.apiAuthHeader.slice(0, i).trim()] = c.apiAuthHeader.slice(i + 1).trim();
    }
    return headers;
}

export interface DeleteOutcome {
    status: "removed" | "already-gone" | "failed";
    reason?: string;
}

/** One DELETE of a recorded address. Never throws. */
export async function deleteRecord(args: {
    apiBaseUrl: string;
    deletePath: string;
    headers: Record<string, string>;
    /** The outbound guard (the platform passes `assertAllowedTarget`). */
    guard?: (url: string) => Promise<void>;
    fetch?: typeof fetch;
    timeoutMs?: number;
}): Promise<DeleteOutcome> {
    try {
        if (!args.deletePath.startsWith("/") || args.deletePath.startsWith("//")) return { status: "failed", reason: "The recorded address is not a path on the application." };
        const base = new URL(args.apiBaseUrl);
        const url = new URL(args.deletePath, base);
        if (url.origin !== base.origin) return { status: "failed", reason: "The recorded address is outside the application, so it was not touched." };
        if (args.guard) await args.guard(url.href);
        const timeoutMs = args.timeoutMs ?? DELETE_TIMEOUT_MS;
        const res = await (args.fetch ?? fetch)(url, { method: "DELETE", headers: args.headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        // The answer's body is never read: it is not needed, and only ids and paths are kept.
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 200 && res.status < 300) return { status: "removed" };
        if (res.status === 404 || res.status === 410) return { status: "already-gone" };
        if (res.status === 401 || res.status === 403) return { status: "failed", reason: `The application refused the delete (HTTP ${res.status}); the credentials may not be allowed to remove it.` };
        if (res.status >= 300 && res.status < 400) return { status: "failed", reason: `The application answered with a redirect (HTTP ${res.status}); redirects are not followed.` };
        return { status: "failed", reason: `The application answered HTTP ${res.status}.` };
    } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (name === "TimeoutError" || name === "AbortError") return { status: "failed", reason: `No answer within ${Math.round((args.timeoutMs ?? DELETE_TIMEOUT_MS) / 1000)} seconds.` };
        const cause = (e as { cause?: { code?: string; status?: unknown } })?.cause;
        // guardedFetch refuses a redirect instead of answering it.
        if (typeof cause?.status === "number") return { status: "failed", reason: `The application answered with a redirect (HTTP ${cause.status}); redirects are not followed.` };
        const code = cause?.code;
        // Messages of guard errors are our own plain sentences; network errors are described by their code, never by their text.
        if (e && typeof e === "object" && "status" in e) return { status: "failed", reason: e instanceof Error ? e.message : "The address is not allowed." };
        return { status: "failed", reason: `Could not reach the application${code ? ` (${code})` : ""}.` };
    }
}

/** Collects the records of one run (or one job), per test and in creation order. */
export class CleanupCollector {
    private readonly list: LedgerItem[] = [];
    private seq = 0;

    /** `ops`: the DELETE operations the API description knows. */
    constructor(private readonly ops: string[]) {}

    add(spec: Pick<TestSpec, "testId" | "steps">, lines: CreatedLine[] | undefined): void {
        if (!lines?.length) return;
        const items = planItems(spec, lines, this.ops, this.seq);
        this.seq += items.length;
        this.list.push(...items);
    }

    /** Collect from a finished script run. */
    addRun(spec: Pick<TestSpec, "testId" | "steps">, run: Pick<ScriptRun, "created">): void {
        this.add(spec, run.created);
    }

    get items(): LedgerItem[] {
        return this.list;
    }
}

export interface FinishArgs {
    /** false = cleanup is switched off: nothing is deleted and the ledger says the records stay. */
    enabled: boolean;
    /** The API address of the run (the delete goes to the same place). */
    apiBaseUrl: string;
    credentials?: CleanupCredentials;
    guard?: (url: string) => Promise<void>;
    fetch?: typeof fetch;
    environment?: string;
    timeoutMs?: number;
}

/**
 * Remove (or, when switched off, only list) what a run created. Returns the finished ledger items, oldest first; the caller stores them.
 * Never throws: a failure is an item with status "failed" and a reason.
 */
export async function finishCleanup(ctx: EngineContext, collector: CleanupCollector, args: FinishArgs): Promise<FinishedItem[]> {
    const items = [...collector.items].sort(byCreation);
    if (items.length === 0) return [];
    let origin: string | undefined;
    try {
        origin = new URL(args.apiBaseUrl).origin;
    } catch {
        /* an unusable address is reported per item below */
    }
    const headers = cleanupHeaders(args.credentials);
    // Newest first: a record that refers to an older one is removed before it.
    for (const item of [...items].reverse()) {
        item.origin = origin;
        if (args.environment) item.environment = args.environment;
        if (item.status) continue; // no way to remove it, or the test removed it itself
        if (!args.enabled) {
            item.status = "skipped";
            item.reason = "Cleanup is switched off for this project, so the record stays in the application.";
            continue;
        }
        const r = await deleteRecord({ apiBaseUrl: args.apiBaseUrl, deletePath: item.deletePath!, headers, guard: args.guard, fetch: args.fetch, timeoutMs: args.timeoutMs });
        item.status = r.status;
        if (r.reason) item.reason = r.reason;
    }
    const finished = items as FinishedItem[];
    const counts = countItems(finished);
    ctx.emit({
        stage: "validation",
        kind: "cleanup_finished",
        level: counts.leftBehind > 0 ? "warn" : "info",
        message: summaryLine(counts),
        data: { created: counts.created, removed: counts.removed, leftBehind: counts.leftBehind },
    });
    return finished;
}

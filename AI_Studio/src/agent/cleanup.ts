/**
 * Test-data cleanup on the agent.
 *
 * The application a remote run tests may only be reachable from the agent's network, so with `env.cleanup = "agent"` the
 * agent removes what the run created. It reuses the platform's own rules (src/engine/cleanup/*): the script only writes down
 * what it created ("platform" ledger mode), the DELETE for each record is re-derived from the operations the script carries,
 * and the DELETEs follow the same safety rules as the platform's cleanup:
 *   - only records this run's scripts captured; nothing is listed, guessed or looked up;
 *   - same origin as the run's API address only, never a redirect, one request at a time, 10 s each, newest first;
 *   - 404 and 410 mean "already gone"; the answer's body is not read; a failure never changes a test's result.
 * The records come back to the platform as ledger lines with their outcome (`WireRun.created`), which the platform stores in
 * its cleanup ledger exactly like a local run's.
 */
import { cleanupHeaders, deleteRecord, DELETE_TIMEOUT_MS } from "../engine/cleanup/run.js";
import { byCreation, countItems, planItems, summaryLine, type CleanupStatus, type CreatedLine, type LedgerItem } from "../engine/cleanup/ledger.js";
import type { RunEnv, ScriptInput, ScriptRun } from "../engine/validation/runner.js";
import { addressProblem, type Lookup } from "./address-guard.js";

/** One record in `WireRun.created`: the line the script wrote, plus the planned DELETE and what happened to it. */
export interface AgentLedgerLine {
    k: "created";
    testId: string;
    seq: number;
    path: string;
    id: string;
    at: string;
    deletePath?: string;
    origin?: string;
    status: CleanupStatus;
    reason?: string;
}

/** The DELETE operations a generated script carries (`const CLEANUP_OPS: string[] = [...]`). Anything unexpected gives none. */
export function opsOfScript(content: string): string[] {
    const m = /const CLEANUP_OPS: string\[\] = (\[[^\n]*\]);/.exec(content);
    if (!m) return [];
    try {
        const v = JSON.parse(m[1]!) as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.startsWith("/") && x.length < 500).slice(0, 500) : [];
    } catch {
        return [];
    }
}

/** Only http(s) addresses, never with credentials in the URL. Private addresses are fine: the agent is on the application's network. */
export async function agentGuard(url: string): Promise<void> {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw Object.assign(new Error("Only http and https addresses are allowed."), { status: 422 });
    if (u.username || u.password) throw Object.assign(new Error("Addresses with a user name or password are not allowed."), { status: 422 });
}

/**
 * The guard for a runner that refuses private addresses (address-guard.ts): the deletes run after the run's address guard is closed, so each
 * one looks its address up again here and a name that now leads to a private or local address is not touched.
 */
export function refusingGuard(lookup?: Lookup): (url: string) => Promise<void> {
    return async (url) => {
        await agentGuard(url);
        const why = await addressProblem(url, lookup);
        if (why) throw Object.assign(new Error(`This record was not removed: ${why}`), { status: 422 });
    };
}

export interface AgentCleanupResult {
    created: number;
    removed: number;
    leftBehind: number;
    summary: string;
}

/** The whole cleanup stage may take this long; what is not done by then is reported as left behind. */
export const CLEANUP_BUDGET_MS = 5 * 60_000;

/**
 * Remove what the runs created and put the outcome on each run (`run.created` becomes ledger lines). Never throws.
 * `deleteTimeoutMs` and `budgetMs` exist for tests.
 */
export async function runAgentCleanup(
    runs: ScriptRun[],
    scripts: ScriptInput[],
    env: RunEnv,
    opts: { deleteTimeoutMs?: number; budgetMs?: number; signal?: AbortSignal; refusePrivate?: boolean; lookup?: Lookup } = {},
): Promise<AgentCleanupResult> {
    const scriptOf = new Map(scripts.map((s) => [s.testId, s]));
    const items: LedgerItem[] = [];
    const owner = new Map<LedgerItem, ScriptRun>();
    let seq = 0;
    for (const run of runs) {
        const lines = (run.created ?? []).filter((l) => l.k === "created" || l.k === "deleted");
        if (lines.length === 0) continue;
        // A stand-in spec: the DELETE operations come from the script itself (they were merged into it when it was generated).
        const planned = planItems({ testId: run.testId, steps: [] }, lines as CreatedLine[], opsOfScript(scriptOf.get(run.testId)?.content ?? ""), seq);
        seq += planned.length;
        for (const p of planned) owner.set(p, run);
        items.push(...planned);
    }

    const apiBaseUrl = env.apiBaseUrl ?? env.baseUrl;
    let origin: string | undefined;
    try {
        origin = new URL(apiBaseUrl).origin;
    } catch {
        /* reported per record below */
    }
    const headers = cleanupHeaders({ apiToken: env.apiToken, apiAuthHeader: env.apiAuthHeader });
    const deadline = Date.now() + (opts.budgetMs ?? CLEANUP_BUDGET_MS);
    const ordered = [...items].sort(byCreation);
    // Newest first: a record that refers to an older one goes before it.
    for (const item of [...ordered].reverse()) {
        if (origin) item.origin = origin;
        if (item.status) continue; // no way to remove it, or the test removed it itself
        if (opts.signal?.aborted || Date.now() > deadline) {
            item.status = "failed";
            item.reason = opts.signal?.aborted ? "The agent was stopped before this record could be removed." : "Cleanup took too long, so this record was left in the application.";
            continue;
        }
        const r = await deleteRecord({ apiBaseUrl, deletePath: item.deletePath!, headers, guard: opts.refusePrivate ? refusingGuard(opts.lookup) : agentGuard, timeoutMs: opts.deleteTimeoutMs ?? DELETE_TIMEOUT_MS });
        item.status = r.status;
        if (r.reason) item.reason = r.reason;
    }

    for (const run of runs) if (run.created) delete run.created;
    for (const item of ordered) {
        const run = owner.get(item)!;
        const line: AgentLedgerLine = {
            k: "created",
            testId: item.testId,
            seq: item.seq,
            path: item.path,
            id: item.id,
            at: item.createdAt,
            ...(item.deletePath ? { deletePath: item.deletePath } : {}),
            ...(item.origin ? { origin: item.origin } : {}),
            status: item.status!,
            ...(item.reason ? { reason: item.reason } : {}),
        };
        (run.created ??= []).push(line as unknown as CreatedLine);
    }
    const counts = countItems(ordered);
    return { created: counts.created, removed: counts.removed, leftBehind: counts.leftBehind, summary: summaryLine(counts) };
}

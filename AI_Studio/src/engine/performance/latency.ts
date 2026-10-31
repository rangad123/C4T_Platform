/**
 * API latency checks: how long do a few safe GET endpoints take to answer? (no LLM)
 *
 * This is a latency check, NOT load testing. Requests go out strictly one at a time (never concurrently): one warm-up
 * request that is discarded, then `runs` measured ones (default 10). The endpoint is left alone at once if it answers
 * HTTP 429 (rate limited) or 5xx — it is reported, never hammered.
 *
 * `LATENCY_HELPER_SOURCE` is plain JavaScript pasted into every script containing a `latency` response check (so a
 * downloaded script runs on its own) and compiled for tests from the same text. The step's `expected` is an optional
 * list of overrides: "p95:1000 p50:400 max:3000 runs:10". Only p95 has a default budget (1 s).
 *
 * Severity per line: over budget by less than 1.5x -> low; at least 1.5x -> medium; at least 3x -> high.
 * Measured values are attached as "metrics" (p50, p95, max) so the history is kept like page speed.
 */
import type { DraftSpec } from "../api/test-specs.js";
import { fillPath, queryFor } from "../api/test-specs.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";

/** First words of every latency failure; the finding classifier keys on it. */
export const LATENCY_FAILURE_PREFIX = "API speed check failed:";

export const LATENCY_DEFAULT_P95_MS = 1000;
export const LATENCY_DEFAULT_RUNS = 10;

export const LATENCY_HELPER_SOURCE = String.raw`const LATENCY_PREFIX = ${JSON.stringify(LATENCY_FAILURE_PREFIX)};
function latencyParse(spec) {
    const b = { p95: ${LATENCY_DEFAULT_P95_MS}, runs: ${LATENCY_DEFAULT_RUNS} };
    for (const tok of String(spec == null ? "" : spec).split(/[\s,;]+/).filter(Boolean)) {
        const m = /^(p50|p95|max|runs)[:=]([0-9.]+)$/i.exec(tok);
        if (m) b[m[1].toLowerCase()] = Number(m[2]);
    }
    b.runs = Math.max(3, Math.min(30, Math.round(b.runs)));
    return b;
}
function latencyPercentile(sorted, p) {
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
function latencyTime(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms"; }

/**
 * Send the request one warm-up time and then b.runs measured times, strictly one after another. send() returns
 * { status }. Fails with one line per budget that was exceeded; metrics go to attach("metrics", json).
 */
async function latencyAssert(send, spec, attach) {
    const b = latencyParse(spec);
    const times = [];
    const report = async () => {
        if (!attach || times.length === 0) return;
        const s = times.slice().sort((x, y) => x - y);
        const out = [
            { metric: "p50", value: Math.round(latencyPercentile(s, 50)), unit: "ms" },
            { metric: "p95", value: Math.round(latencyPercentile(s, 95)), unit: "ms", budget: b.p95 },
            { metric: "max", value: Math.round(s[s.length - 1]), unit: "ms" },
        ];
        if (b.p50 !== undefined) out[0].budget = b.p50;
        if (b.max !== undefined) out[2].budget = b.max;
        await attach("metrics", JSON.stringify(out));
    };
    for (let i = 0; i <= b.runs; i++) {
        const t0 = Date.now();
        const r = await send();
        const ms = Date.now() - t0;
        if (r.status === 429) {
            await report();
            throw new Error(LATENCY_PREFIX + " 1 problem: this endpoint limits how often it can be called (HTTP 429), so its speed could not be measured\n- [low] It answered HTTP 429 after " + i + (i === 1 ? " request" : " requests") + "; measuring stopped there");
        }
        if (r.status >= 500) {
            await report();
            throw new Error(LATENCY_PREFIX + " 1 problem: this endpoint fails instead of answering (HTTP " + r.status + ")\n- [high] It answered HTTP " + r.status + " on request " + (i + 1) + "; measuring stopped there");
        }
        if (i > 0) times.push(ms);
    }
    await report();
    const sorted = times.slice().sort((x, y) => x - y);
    const p50 = latencyPercentile(sorted, 50);
    const p95 = latencyPercentile(sorted, 95);
    const max = sorted[sorted.length - 1];
    const sev = (v, budget) => (v >= budget * 3 ? "high" : v >= budget * 1.5 ? "medium" : "low");
    const lines = [];
    if (p95 > b.p95) lines.push("- [" + sev(p95, b.p95) + "] 95% of responses arrive within " + latencyTime(p95) + " (budget " + latencyTime(b.p95) + "); typically " + latencyTime(p50) + ", slowest " + latencyTime(max));
    if (b.p50 !== undefined && p50 > b.p50) lines.push("- [" + sev(p50, b.p50) + "] The typical (median) response takes " + latencyTime(p50) + " (budget " + latencyTime(b.p50) + ")");
    if (b.max !== undefined && max > b.max) lines.push("- [" + sev(max, b.max) + "] The slowest of " + b.runs + " requests took " + latencyTime(max) + " (budget " + latencyTime(b.max) + ")");
    if (lines.length === 0) return;
    throw new Error(LATENCY_PREFIX + " " + lines.length + (lines.length === 1 ? " measurement is" : " measurements are") + " over budget for this endpoint (" + b.runs + " requests, one at a time)\n" + lines.join("\n"));
}
`;

export interface LatencyRuntime {
    latencyAssert(send: () => Promise<{ status: number }>, spec: string | undefined, attach?: (name: string, body: string) => Promise<void> | void): Promise<void>;
    latencyParse(spec: string | undefined): { p95: number; p50?: number; max?: number; runs: number };
}

let runtime: LatencyRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use inside the engine and in tests. */
export function loadLatencyRuntime(): LatencyRuntime {
    runtime ??= new Function(`${LATENCY_HELPER_SOURCE}\nreturn { latencyAssert, latencyParse };`)() as LatencyRuntime;
    return runtime;
}

export const LATENCY_ADVICE =
    "Look at what the endpoint does per request: slow database queries, missing indexes, work that could be cached, or calls to other services. Compare with how long it takes when nothing else is running.";

export const LATENCY_BASIS = "API endpoint answers slowly";

export interface LatencyGenOptions {
    maxEndpoints: number;
    /** Budget overrides, e.g. "p95:500 max:2000 runs:15". */
    budgets?: string;
}

const budgetLabel = (budgets?: string) => {
    const m = /(?:^|[\s,;])p95[:=]([0-9.]+)/i.exec(budgets ?? "");
    const ms = m ? Number(m[1]) : LATENCY_DEFAULT_P95_MS;
    return ms >= 1000 ? `${+(ms / 1000).toFixed(1)} s` : `${ms} ms`;
};

/** A few safe GET endpoints that can be called with what the description or the traffic already provides. */
export function generateLatencySpecs(endpoints: ApiEndpointModel[], opts: LatencyGenOptions): DraftSpec[] {
    const out: DraftSpec[] = [];
    for (const ep of endpoints) {
        if (out.length >= opts.maxEndpoints) break;
        if (ep.method !== "GET") continue;
        const path = ep.source === "openapi" ? fillPath(ep.path, ep) : (ep.examplePath ?? ep.path);
        if (!path || path.includes("{")) continue;
        const steps: Step[] = [
            { action: "request", method: "GET", path, ...(queryFor(ep) ? { query: queryFor(ep) } : {}), auth: "default", description: `Send GET ${path}` },
            { action: "assertResponse", check: "latency", ...(opts.budgets ? { expected: opts.budgets } : {}), description: `Responses arrive quickly (95% within ${budgetLabel(opts.budgets)}), measured one request at a time` },
        ];
        out.push({
            title: `GET ${ep.path}: responds quickly`,
            description: `Calls the endpoint ${LATENCY_DEFAULT_RUNS} times, one after another (one extra warm-up request is not counted), and compares the typical and the slowest response times with the budget. Not a load test.`,
            kind: "api",
            category: "Performance",
            type: "performance",
            priority: "medium",
            preconditions: ep.requiresAuth ? ["A valid API credential is configured (API_TOKEN)"] : [],
            steps,
            expectedResults: [`95% of responses arrive within ${budgetLabel(opts.budgets)}`],
            testData: {},
            tags: ["api", "performance"],
            source: { origin: "performance-check" },
        });
    }
    return out;
}

function ownMessage(text: string): string | undefined {
    const at = text.indexOf(LATENCY_FAILURE_PREFIX);
    if (at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim();
}

/** A failed run is a latency finding only when the failing step is the latency check and its error is the check's own message. */
export function latencyFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const isStep = (s: Step | undefined) => s?.action === "assertResponse" && s.check === "latency";
    let message: string | undefined;
    for (const st of run.steps) if (st.status === "failed" && isStep(spec.steps[st.index])) message = ownMessage(st.error ?? "") ?? message;
    if (!message && run.steps.length === 0 && spec.steps.some(isStep)) message = ownMessage(run.error ?? "");
    return message ? `${message}\nHow to fix: ${LATENCY_ADVICE}`.slice(0, 2500) : undefined;
}

/** Worst severity of a latency finding reason (undefined if it is not one). */
export function parseLatencyReason(reason: string): "high" | "medium" | "low" | undefined {
    if (!reason.includes(LATENCY_FAILURE_PREFIX)) return undefined;
    const body = reason.split(/^how to fix:/im)[0] ?? "";
    for (const s of ["high", "medium", "low"] as const) if (body.includes(`[${s}]`)) return s;
    return "low";
}

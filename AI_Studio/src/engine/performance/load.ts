/**
 * Basic load check for a few safe GET endpoints: does the endpoint stay fast and error-free when up to 10 people use it at
 * once? (no LLM). It is NOT a stress or capacity-planning tool.
 *
 * Safety is the point of this file, so every limit is a CONSTANT inside the pasted helper, and a spec can only lower them:
 *   - at most 10 concurrent virtual users (a user never has two requests in flight);
 *   - at most 300 requests per endpoint IN TOTAL: the test's own preliminary request, the main run and the confirmation re-run;
 *   - at most 10 seconds per run, users ramp up over at most 3 seconds, and each user pauses between its requests;
 *   - only GET (the sender takes no method), never retried, and the endpoint is left alone at once (reported as "stopped to
 *     protect the application") when more than 20% of the answers are server/network errors or any answer is HTTP 429.
 * `expected` is an optional list of overrides "p95:1000 errors:1 users:10 seconds:10 requests:300"; every number is clamped to
 * the caps by the helper itself and again by the generator, so editing a spec (or a downloaded script's text field) cannot
 * ask for more.
 *
 * Judging: p95 <= 1000 ms and error rate <= 1% by default. A run that breaches a budget (or is stopped for errors) is NOT
 * reported on the first try: the endpoint is run once more at half the users. The finding then says "struggled at N users"
 * (N = the lowest level that failed) and whether the endpoint coped at half. A 429 is never a finding (the limiter works): the
 * test passes with a note.
 *
 * `LOAD_HELPER_SOURCE` is plain JavaScript pasted into every script containing a `load` response check (so a downloaded
 * script runs on its own) and compiled for tests from the same text. Time and sleeping are injectable (`env`) so tests can
 * judge the math with a virtual clock.
 */
import type { DraftSpec } from "../api/test-specs.js";
import { fillPath, queryFor } from "../api/test-specs.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";

/** First words of every load failure; the finding classifier keys on it. */
export const LOAD_FAILURE_PREFIX = "Load check failed:";

export const LOAD_MAX_USERS = 10;
export const LOAD_MAX_REQUESTS = 300;
export const LOAD_MAX_SECONDS = 10;
export const LOAD_MAX_ENDPOINTS = 3;
export const LOAD_DEFAULT_P95_MS = 1000;
export const LOAD_DEFAULT_ERROR_PERCENT = 1;

/** The plain reason shown for a load test that production skipped. */
export const LOAD_PRODUCTION_SKIP_REASON = "load checks don't run on production, so this test was not run here.";

export const LOAD_HELPER_SOURCE = String.raw`const LOAD_PREFIX = ${JSON.stringify(LOAD_FAILURE_PREFIX)};
const LOAD_MAX_USERS = ${LOAD_MAX_USERS};
const LOAD_MAX_REQUESTS = ${LOAD_MAX_REQUESTS};
const LOAD_MAX_SECONDS = ${LOAD_MAX_SECONDS};
const LOAD_RAMP_MS = 3000;
const LOAD_STOP_ERROR_RATE = 0.2;
const LOAD_STOP_MIN_SAMPLE = 5;
function loadNum(v, def, lo, hi) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}
function loadParse(spec) {
    const raw = {};
    for (const tok of String(spec == null ? "" : spec).split(/[\s,;]+/).filter(Boolean)) {
        const m = /^(p95|errors|users|seconds|requests)[:=]([0-9.]+)$/i.exec(tok);
        if (m) raw[m[1].toLowerCase()] = m[2];
    }
    return {
        p95: loadNum(raw.p95, ${LOAD_DEFAULT_P95_MS}, 1, 600000),
        errors: loadNum(raw.errors, ${LOAD_DEFAULT_ERROR_PERCENT}, 0, 100),
        users: Math.round(loadNum(raw.users, LOAD_MAX_USERS, 2, LOAD_MAX_USERS)),
        seconds: loadNum(raw.seconds, LOAD_MAX_SECONDS, 2, LOAD_MAX_SECONDS),
        requests: Math.round(loadNum(raw.requests, LOAD_MAX_REQUESTS, 10, LOAD_MAX_REQUESTS)),
    };
}
function loadPercentile(sorted, p) {
    return sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
function loadTime(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms"; }
function loadPlural(n, one, many) { return n + " " + (n === 1 ? one : many); }
const loadRealEnv = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * One run: users start spread over the ramp, then each sends a request, waits for the answer and pauses so that the request
 * budget lasts for the whole window. The request counter is reserved before the request is sent (exact cap), and a user has at
 * most one request in flight (so at most "users" at once). send() returns { status }; a thrown error is a network failure.
 */
async function loadStage(send, users, cap, seconds, env) {
    const hold = seconds * 1000;
    const ramp = Math.min(LOAD_RAMP_MS, hold * 0.3);
    const pace = Math.max(1, Math.round((hold * users) / cap));
    const st = { users, started: 0, done: 0, errors: 0, ok: 0, c4xx: 0, s5xx: 0, r429: 0, net: 0, times: [], inFlight: 0, peak: 0, stop: undefined, t0: env.now(), elapsed: 0 };
    const deadline = st.t0 + hold;
    const live = () => !st.stop && st.started < cap && env.now() < deadline;
    const user = async (i) => {
        await env.sleep(Math.round((i * ramp) / users));
        let next = env.now();
        while (live()) {
            const wait = next - env.now();
            if (wait > 0) await env.sleep(wait);
            if (!live()) break;
            st.started++;
            st.inFlight++;
            if (st.inFlight > st.peak) st.peak = st.inFlight;
            next = env.now() + pace;
            const t = env.now();
            let status = 0;
            try { status = Number((await send()).status) || 0; } catch { status = 0; }
            const ms = env.now() - t;
            st.inFlight--;
            st.done++;
            if (status === 0) { st.net++; st.errors++; }
            else {
                st.times.push(ms);
                if (status >= 500) { st.s5xx++; st.errors++; }
                else if (status === 429) st.r429++;
                else if (status >= 400) st.c4xx++;
                else st.ok++;
            }
            if (st.r429 > 0) st.stop = "rate";
            else if (st.done >= LOAD_STOP_MIN_SAMPLE && st.errors / st.done > LOAD_STOP_ERROR_RATE && !st.stop) st.stop = "errors";
        }
    };
    await Promise.all(Array.from({ length: users }, (_, i) => user(i)));
    st.elapsed = Math.max(1, env.now() - st.t0);
    const sorted = st.times.slice().sort((a, b) => a - b);
    st.p50 = loadPercentile(sorted, 50);
    st.p95 = loadPercentile(sorted, 95);
    st.max = sorted.length ? sorted[sorted.length - 1] : 0;
    st.rps = st.done / (st.elapsed / 1000);
    st.errorPercent = st.done ? (st.errors / st.done) * 100 : 0;
    return st;
}

/** What is wrong with a finished run, as { kind, severity, text } lines (none = within budget). A single stray error is not a breach. */
function loadProblems(b, st) {
    const out = [];
    if (st.stop === "errors") out.push({ kind: "stopped", severity: "medium", text: "Stopped to protect the application: more than " + Math.round(LOAD_STOP_ERROR_RATE * 100) + "% of the requests failed (" + st.errors + " of " + st.done + ")" });
    if (st.times.length > 0 && st.p95 > b.p95) out.push({ kind: "p95", severity: "medium", text: "95% of responses arrive within " + loadTime(st.p95) + " (budget " + loadTime(b.p95) + "); typically " + loadTime(st.p50) + ", slowest " + loadTime(st.max) });
    if (st.stop !== "errors" && st.errors >= 2 && st.errorPercent > b.errors) {
        out.push({ kind: "errors", severity: st.errorPercent > 5 ? "medium" : "low", text: st.errorPercent.toFixed(1) + "% of requests failed (budget " + b.errors + "%): " + loadPlural(st.s5xx, "server error", "server errors") + ", " + loadPlural(st.net, "network failure", "network failures") });
    }
    return out;
}

function loadSummary(st) {
    return loadPlural(st.done, "request", "requests") + " at " + st.users + " users, 95% within " + loadTime(st.p95) + ", " + st.errorPercent.toFixed(1) + "% failed";
}

/**
 * Run the load check. probeStatus is the status of the test's own preliminary request: anything but a success means the endpoint
 * is not put under load at all. Passing runs may add a plain note (attach("notes", json)); metrics of the main run are attached
 * every time. Fails (LOAD_PREFIX) only for a confirmed problem.
 */
async function loadAssert(send, spec, attach, probeStatus, options) {
    const env = (options && options.env) || loadRealEnv;
    const b = loadParse(spec);
    const note = async (text) => { if (attach) await attach("notes", JSON.stringify([text])); };
    if (probeStatus !== undefined && !(probeStatus >= 200 && probeStatus < 400)) {
        await note("Load check skipped: a single request answered HTTP " + probeStatus + ", so the endpoint was not put under load.");
        return;
    }
    await loadWithLock(options && options.lockKey, env, () => loadRunAll(send, b, attach, note, env));
}

/**
 * Only one load check at a time per application address on this machine, across the test workers: two checks side by side
 * would put 20 or 30 users on the application, not 10. The lock is a directory in the temp folder (creating it is atomic);
 * one left behind by a crashed run is ignored after a minute (a check takes well under that).
 */
async function loadWithLock(key, env, work) {
    if (!key) return work();
    const fs = process.getBuiltinModule("node:fs");
    const os = process.getBuiltinModule("node:os");
    const path = process.getBuiltinModule("node:path");
    const dir = path.join(os.tmpdir(), "ai-testing-load-" + String(key).replace(/[^a-z0-9]+/gi, "_"));
    const giveUp = env.now() + 120000;
    for (;;) {
        try { fs.mkdirSync(dir); break; } catch (e) {
            if (!e || e.code !== "EEXIST") throw new Error("Load check could not run: it could not coordinate with other load checks (" + (e && e.code ? e.code : "temp folder not writable") + ")");
            try { if (Date.now() - fs.statSync(dir).mtimeMs > 60000) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the other check just finished */ }
            if (env.now() > giveUp) throw new Error("Load check could not run: another load check kept the application busy for two minutes");
            await env.sleep(250);
        }
    }
    try { return await work(); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
}

async function loadRunAll(send, b, attach, note, env) {
    // One request (the test's own) is already spent; the rest is split two thirds for the main run, one third for the confirmation.
    const rest = b.requests - 1;
    const cap1 = Math.max(1, Math.ceil((rest * 2) / 3));
    const cap2 = Math.max(1, rest - cap1);
    const first = await loadStage(send, b.users, cap1, b.seconds, env);
    if (attach && first.done > 0) {
        const m = (metric, value, unit, budget) => ({ metric, value: Math.round(value * 10) / 10, unit, ...(budget === undefined ? {} : { budget }) });
        await attach("metrics", JSON.stringify([
            m("load_users", first.users, "users"),
            m("load_requests", first.done, "count"),
            m("load_rps", first.rps, "req/s"),
            m("load_error_rate", first.errorPercent, "%", b.errors),
            m("load_p50", first.p50, "ms"),
            m("load_p95", first.p95, "ms", b.p95),
            m("load_max", first.max, "ms"),
            m("load_ok", first.ok, "count"),
            m("load_4xx", first.c4xx, "count"),
            m("load_5xx", first.s5xx, "count"),
            m("load_429", first.r429, "count"),
            m("load_network", first.net, "count"),
        ]));
    }
    if (first.stop === "rate") {
        await note("The endpoint limits how often it can be called (HTTP 429). Load was stopped after " + loadPlural(first.done, "request", "requests") + " to protect the application, so its speed under load was not measured.");
        return;
    }
    const p1 = loadProblems(b, first);
    if (p1.length === 0) return;

    const halfUsers = Math.max(1, Math.floor(b.users / 2));
    const second = await loadStage(send, halfUsers, cap2, b.seconds, env);
    if (second.stop === "rate") {
        await note("The confirmation run was stopped by an HTTP 429 (rate limit) after " + loadPlural(second.done, "request", "requests") + ", so the first run's problems could not be confirmed.");
        return;
    }
    const p2 = loadProblems(b, second);
    const level = p2.length ? halfUsers : b.users;
    const shown = (p2.length ? p2 : p1);
    const lines = shown.map((p) => "- [" + p.severity + "] " + p.text);
    lines.push("- Run at " + b.users + " users: " + loadSummary(first));
    lines.push("- Confirmation at " + halfUsers + " users: " + loadSummary(second) + (p2.length ? " (also over budget)" : " (within budget)"));
    throw new Error(LOAD_PREFIX + " the endpoint struggled at " + level + " users at once" + (p2.length ? "" : " (it coped with " + halfUsers + ")") + "\n" + lines.join("\n"));
}
`;

export interface LoadStats {
    users: number;
    started: number;
    done: number;
    errors: number;
    ok: number;
    c4xx: number;
    s5xx: number;
    r429: number;
    net: number;
    peak: number;
    elapsed: number;
    stop?: "rate" | "errors";
    p50: number;
    p95: number;
    max: number;
    rps: number;
    errorPercent: number;
}

export interface LoadBudgets {
    p95: number;
    errors: number;
    users: number;
    seconds: number;
    requests: number;
}

export interface LoadEnv {
    now(): number;
    sleep(ms: number): Promise<void>;
}

export interface LoadRuntime {
    loadAssert(
        send: () => Promise<{ status: number }>,
        spec: string | undefined,
        attach?: (name: string, body: string) => Promise<void> | void,
        probeStatus?: number,
        options?: { env?: LoadEnv; lockKey?: string },
    ): Promise<void>;
    loadParse(spec: string | undefined): LoadBudgets;
    loadStage(send: () => Promise<{ status: number }>, users: number, cap: number, seconds: number, env: LoadEnv): Promise<LoadStats>;
}

let runtime: LoadRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use inside the engine and in tests. */
export function loadLoadRuntime(): LoadRuntime {
    runtime ??= new Function(`${LOAD_HELPER_SOURCE}\nreturn { loadAssert, loadParse, loadStage };`)() as LoadRuntime;
    return runtime;
}

/** The sender every generated load script uses: GET only (it takes no method), a short timeout, and no recording of the answers. */
export const LOAD_CALL_SOURCE = `
/** Sends one GET for a load check. There is no method parameter on purpose: a load check never sends anything else. */
async function loadCall(request: APIRequestContext, path: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; auth: boolean }): Promise<{ status: number }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const target = await allowedAddress(path, API_BASE_URL);
    if (opts.auth) {
        assertOwnOrigin(target, API_BASE_URL);
        if (process.env.API_TOKEN) headers["Authorization"] = \`Bearer \${process.env.API_TOKEN}\`;
        if (process.env.API_AUTH_HEADER) {
            const i = process.env.API_AUTH_HEADER.indexOf(":");
            if (i > 0) headers[process.env.API_AUTH_HEADER.slice(0, i).trim()] = process.env.API_AUTH_HEADER.slice(i + 1).trim();
        }
    }
    const res = await request.fetch(target, { method: "GET", headers, params: opts.query, failOnStatusCode: false, maxRedirects: 0, ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS, timeout: 8000 });
    await res.body();
    return { status: res.status() };
}
`;

/** The `expected` text of a load step with every number clamped to the caps, in a fixed form (what the generated script carries). */
export function normalizeLoadBudgets(expected: unknown): string {
    const b = loadLoadRuntime().loadParse(typeof expected === "string" ? expected : "");
    return `p95:${b.p95} errors:${b.errors} users:${b.users} seconds:${b.seconds} requests:${b.requests}`;
}

export const isLoadStep = (s: Step | undefined): boolean => s?.action === "assertResponse" && s.check === "load";
export const isLoadSpec = (spec: Pick<TestSpec, "steps">): boolean => spec.steps.some(isLoadStep);

export const LOAD_ADVICE =
    "Look for work that is serialised or shared between requests: database connection limits, locks, missing caches, a single worker or thread, or calls to a slow service. Retry on a test environment with the same load while watching the server's own metrics.";

export const LOAD_BASIS = "API endpoint struggles under load";

export interface LoadGenOptions {
    maxEndpoints?: number;
    /** Budget overrides, e.g. "p95:500 errors:2 users:5". Clamped to the caps. */
    budgets?: string;
    /** The project has an API token / auth header: endpoints that need sign-in are included only then. */
    hasCredential?: boolean;
}

/** Paths that look like sign-in, sign-up, payment or anything else that does something when called (a superset of the form-input check's exclusions). */
const RISKY_PATH = /log-?in|sign-?in|sign-?up|register|checkout|payment|\bpay\b|cart|order|delete|remove|log-?out|subscribe|token|oauth|password|passwd|otp|reset|verify|webhook|callback|upload|send|email|sms|invite|export|download/i;

const budgetText = (budgets?: string) => {
    const b = loadLoadRuntime().loadParse(budgets ?? "");
    return { p95: b.p95 >= 1000 ? `${+(b.p95 / 1000).toFixed(1)} s` : `${b.p95} ms`, users: b.users };
};

/** A few safe GET endpoints (at most 3) that can be called with what the description or the traffic already provides. */
export function generateLoadSpecs(endpoints: ApiEndpointModel[], opts: LoadGenOptions = {}): DraftSpec[] {
    const out: DraftSpec[] = [];
    const max = Math.min(LOAD_MAX_ENDPOINTS, Math.max(0, Math.floor(opts.maxEndpoints ?? LOAD_MAX_ENDPOINTS)));
    const norm = normalizeLoadBudgets(opts.budgets);
    const text = budgetText(opts.budgets);
    for (const ep of endpoints) {
        if (out.length >= max) break;
        if (ep.method !== "GET") continue;
        if (RISKY_PATH.test(ep.path)) continue;
        if (ep.requiresAuth && !opts.hasCredential) continue;
        // An endpoint that was never seen (or documented) answering successfully is not worth putting under load.
        if (ep.statuses.length > 0 && !ep.statuses.some((s) => s >= 200 && s < 400)) continue;
        const path = ep.source === "openapi" ? fillPath(ep.path, ep) : (ep.examplePath ?? ep.path);
        if (!path || path.includes("{") || RISKY_PATH.test(path.split("?")[0]!)) continue;
        const steps: Step[] = [
            { action: "request", method: "GET", path, ...(queryFor(ep) ? { query: queryFor(ep) } : {}), auth: "default", description: `Send GET ${path}` },
            { action: "assertResponse", check: "load", expected: norm, description: `Stays fast and error-free with ${text.users} users at once (95% within ${text.p95})` },
        ];
        out.push({
            title: `GET ${ep.path}: handles ${text.users} users at once`,
            description: `Sends GET requests as up to ${text.users} users at the same time for about ${LOAD_MAX_SECONDS} seconds (at most ${LOAD_MAX_REQUESTS} requests in all, never anything but GET) and compares how fast and how reliably the endpoint answers with the budget. It stops at once if the endpoint starts failing or limits the calls. Not a stress test. Use a test environment.`,
            kind: "api",
            category: "Performance",
            type: "performance",
            priority: "low",
            preconditions: ep.requiresAuth ? ["A valid API credential is configured (API_TOKEN)"] : [],
            steps,
            expectedResults: [`95% of responses arrive within ${text.p95}, and at most ${loadLoadRuntime().loadParse(opts.budgets ?? "").errors}% of requests fail, with ${text.users} users at once`],
            testData: {},
            tags: ["api", "performance", "load"],
            source: { origin: "performance-check" },
        });
    }
    return out;
}

function ownMessage(text: string): string | undefined {
    const at = text.indexOf(LOAD_FAILURE_PREFIX);
    if (at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim();
}

/** A failed run is a load finding only when the failing step is the load check and its error is the check's own message. */
export function loadFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    let message: string | undefined;
    for (const st of run.steps) if (st.status === "failed" && isLoadStep(spec.steps[st.index])) message = ownMessage(st.error ?? "") ?? message;
    if (!message && run.steps.length === 0 && spec.steps.some(isLoadStep)) message = ownMessage(run.error ?? "");
    return message ? `${message}\nHow to fix: ${LOAD_ADVICE}`.slice(0, 2500) : undefined;
}

/** Worst severity of a load finding reason (undefined if it is not one). */
export function parseLoadReason(reason: string): "high" | "medium" | "low" | undefined {
    if (!reason.includes(LOAD_FAILURE_PREFIX)) return undefined;
    const body = reason.split(/^how to fix:/im)[0] ?? "";
    for (const s of ["high", "medium", "low"] as const) if (body.includes(`[${s}]`)) return s;
    return "low";
}

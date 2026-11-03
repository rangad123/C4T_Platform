/**
 * The evaluation harness: for each corpus entry, the normal exploration through the platform's API (explore and plan, then create the tests
 * from the plan, exactly what a person does on the screens), then every created test is run again N times, and the numbers are worked out
 * from what the platform recorded (see metrics.ts for what each one means).
 *
 * Nothing here judges a test by itself: verdicts, failure reasons, AI calls and tokens are the platform's own records. An entry that cannot
 * run (missing sign-in variable, fixture not available) is skipped with the reason; one that breaks is marked failed with the platform's
 * message, and the next entry still runs. Stopping (the signal) stops the job in progress on the platform as well.
 */
import fs from "node:fs";
import path from "node:path";
import { credentialsFromEnv, targetsOf, type Corpus, type CorpusEntry } from "./corpus.js";
import { ApiError, ok, type PlatformClient } from "./client.js";
import type { FixtureHost } from "./fixtures.js";
import { entryMetrics, overallOf, ratesOf, type TestObservation, type Verdict } from "./metrics.js";
import { MAX_TESTS_PER_ENTRY, type EntryResult, type EvalRun, type UsageDetail } from "./run.js";

export interface HarnessOptions {
    /** Reruns of every created test (1-10). */
    repeat: number;
    /** Explore and plan only: nothing is created or run (cheaper; measures planning, coverage found, time and AI use). */
    planOnly: boolean;
    only?: string[];
    fixtures: FixtureHost;
    /** The AI model's name, as the platform reports it. */
    model: string;
    signal?: AbortSignal;
    log?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
    /** How often a job is checked (ms). */
    pollMs?: number;
    /** Longest one job (exploration, creation or one rerun) may take before it is stopped (ms). */
    jobTimeoutMs?: number;
    /**
     * Explore and create once first, in the same project, without measuring it (the comparison's --warm): the measured exploration then
     * starts from site memory, so exploration reuse has something to reuse. The warm-up's tests and AI use are left out of the numbers.
     */
    warm?: boolean;
}

const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
/** At most this many created tests are read one by one for coverage and duplicates. */
const MAX_DETAILS = 200;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Stopped extends Error {}

const toVerdict = (state: string | undefined): Verdict => (state === "passed" || state === "failed" || state === "finding" ? state : "not_run");

/** "/products/" and "http://host/products?x" both become "/products". */
function pathOf(url: string, base: string): string | undefined {
    try {
        const p = new URL(url.replace(/\{\{[^}]+\}\}/g, ""), base).pathname.replace(/\/+$/, "");
        return p || "/";
    } catch {
        return undefined;
    }
}

const fingerprint = (steps: unknown): string => JSON.stringify(Array.isArray(steps) ? steps.map((s) => (s && typeof s === "object" ? { ...(s as object), description: undefined } : s)) : []);

export async function runCorpus(client: PlatformClient, corpus: Corpus, o: HarnessOptions): Promise<EvalRun> {
    const startedAt = new Date().toISOString();
    const log = o.log ?? (() => undefined);
    const entries: EntryResult[] = [];
    const chosen = o.only?.length ? corpus.entries.filter((e) => o.only!.includes(e.id)) : corpus.entries;
    for (const entry of chosen) {
        if (o.signal?.aborted) {
            entries.push({ id: entry.id, kind: entry.kind, status: "skipped", reason: "The evaluation was stopped before this entry started." });
            continue;
        }
        log(`\n${entry.id} (${entry.kind === "web" ? "website" : "Android app"})`);
        const result = await runEntry(client, entry, o, log);
        log(`  ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
        entries.push(result);
    }
    const overall = overallOf(entries);
    if (o.planOnly) overall.rates.coverage = null;
    return { format: 1, corpus: corpus.name, startedAt, finishedAt: new Date().toISOString(), repeat: o.repeat, planOnly: o.planOnly, platform: { mode: client.mode, model: o.model.slice(0, 200) }, entries, overall };
}

async function runEntry(client: PlatformClient, entry: CorpusEntry, o: HarnessOptions, log: (s: string) => void): Promise<EntryResult> {
    const base: EntryResult = { id: entry.id, kind: entry.kind, status: "skipped" };
    const fixture = o.fixtures.resolve(entry);
    if ("skip" in fixture) return { ...base, reason: fixture.skip };
    let credentials = fixture.credentials;
    if (!credentials) {
        const c = credentialsFromEnv(entry, o.env);
        if (c.missing.length) return { ...base, reason: `Set ${c.missing.join(" and ")} in the environment (the sign-in details of this entry).` };
        credentials = c.values;
    }
    if (entry.apk && !fs.existsSync(entry.apk)) return { ...base, reason: `The app file ${path.basename(entry.apk)} was not found.` };

    const pollMs = o.pollMs ?? 1000;
    const jobTimeoutMs = o.jobTimeoutMs ?? 45 * 60_000;
    const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, what: string, body?: unknown) => ok(await client.call(method, url, body), what);
    let active: string | undefined;
    /** Wait for a job; stop it on the platform when the evaluation is stopped or it takes too long. */
    const finished = async (jobId: string): Promise<any> => {
        active = jobId;
        const end = Date.now() + jobTimeoutMs;
        for (;;) {
            const job = await call("GET", `/api/test-generation/${jobId}`, "Reading the job");
            if (DONE.includes(job.status)) {
                active = undefined;
                return job;
            }
            if (o.signal?.aborted || Date.now() > end) {
                await client.call("DELETE", `/api/test-generation/${jobId}`).catch(() => undefined);
                active = undefined;
                throw new Stopped(o.signal?.aborted ? "Stopped by you; the job in progress was stopped on the platform." : `A job took longer than ${Math.round(jobTimeoutMs / 60_000)} minutes and was stopped.`);
            }
            await sleep(pollMs);
        }
    };

    const t0 = Date.now();
    const out: EntryResult = { ...base, status: "failed" };
    try {
        // To the second: project names are unique in an organisation, and two runs can start in the same minute.
        const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        const project = await call("POST", "/api/projects", "Creating the project", { name: `Eval: ${entry.id} (${stamp})`.slice(0, 100) });
        out.projectId = project.id;
        // The evaluation measures the tests the AI writes, by running them again: in its own throwaway project they need no review first
        // (otherwise they are drafts and drafts never run).
        await call("PUT", `/api/projects/${project.id}/review-policy`, "Letting the AI's tests run without review", { aiGenerated: false });
        const targets = targetsOf(entry);
        if (entry.kind === "android") {
            await call("PUT", `/api/projects/${project.id}/mobile-app`, "Setting the Android app", { appPackage: fixture.appPackage ?? entry.appPackage });
            if (entry.apk) ok(await client.upload(`/api/projects/${project.id}/mobile-app/apk?filename=${encodeURIComponent(path.basename(entry.apk))}`, fs.readFileSync(entry.apk)), "Sending the app file");
        }
        const checks = entry.checks === false ? { accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false } : {};
        const exploration = {
            ...(entry.kind === "web" ? { url: fixture.url ?? entry.url } : {}),
            targets,
            plan: true,
            ...(entry.maxPages ? { maxPages: entry.maxPages } : {}),
            ...(entry.maxScenarios ? { maxScenarios: entry.maxScenarios } : {}),
            ...checks,
            ...(credentials ? { credentials } : {}),
        };
        /** Tests the warm-up created: not part of what is measured. */
        const warmTests = new Set<string>();
        if (o.warm) {
            log("  warming up (one exploration and creation first, not measured)...");
            const w = await call("POST", `/api/projects/${project.id}/test-generation`, "Starting the warm-up exploration", exploration);
            const wj = await finished(w.jobId);
            if (wj.status === "FAILED") throw new Error(`The warm-up exploration failed: ${wj.error ?? "no reason given"}`);
            const wc = await call("POST", `/api/projects/${project.id}/plans/${w.jobId}/create`, "Creating the warm-up tests", {});
            await finished(wc.jobId);
            for (const t of (await call("GET", `/api/projects/${project.id}/tests`, "Reading the warm-up tests")) as Array<{ id: string }>) warmTests.add(t.id);
        }
        const started = await call("POST", `/api/projects/${project.id}/test-generation`, "Starting the exploration", exploration);
        out.planJobId = started.jobId;
        log("  exploring...");
        const planJob = await finished(started.jobId);
        if (planJob.status === "FAILED") throw new Error(`The exploration failed: ${planJob.error ?? "no reason given"}`);
        const plan = await call("GET", `/api/projects/${project.id}/plans/${started.jobId}`, "Reading the plan");
        const events = (await call("GET", `/api/test-generation/${started.jobId}/events`, "Reading the exploration's events")) as Array<{ kind: string }>;
        const phone = entry.kind === "android";
        const safetyRefusals = phone ? events.filter((e) => e.kind === "mobile_action_skipped").length : null;
        const found = phone ? (plan.phone?.screens?.length ?? plan.found?.screens ?? 0) : (plan.found?.pages ?? 0);
        log(`  plan: ${plan.total ?? 0} tests, ${found} ${phone ? "screens" : "pages"} found`);
        const jobIds = [started.jobId as string];

        let tests: TestObservation[] = [];
        let covered = 0;
        let repairsFixed = 0;
        if (!o.planOnly) {
            const created = await call("POST", `/api/projects/${project.id}/plans/${started.jobId}/create`, "Creating the tests", {});
            out.createJobId = created.jobId;
            jobIds.push(created.jobId);
            log("  creating and running the tests...");
            const createJob = await finished(created.jobId);
            if (createJob.status === "FAILED") throw new Error(`Creating the tests failed: ${createJob.error ?? "no reason given"}`);
            const list = ((await call("GET", `/api/projects/${project.id}/tests`, "Reading the tests")) as Array<{ id: string; testId: string; title: string }>).filter((t) => !warmTests.has(t.id)).slice(0, MAX_TESTS_PER_ENTRY);
            const first = await call("GET", `/api/projects/${project.id}/runs/${created.jobId}`, "Reading the first run");
            const firstOf = new Map<string, { state: string; reason?: string }>((first.tests ?? []).map((t: { id: string; state: string; reason?: string }) => [t.id, t]));
            const reruns = new Map<string, Verdict[]>(list.map((t) => [t.id, []]));
            const reasons = new Map<string, string | undefined>(list.map((t) => [t.id, firstOf.get(t.id)?.reason]));
            for (let i = 1; i <= o.repeat && list.length; i++) {
                log(`  rerun ${i} of ${o.repeat}...`);
                const r = await client.call("POST", `/api/projects/${project.id}/runs`, { testIds: list.map((t) => t.id) });
                if (r.status === 422) {
                    // Nothing of it can run here (for example phone tests without a phone): every test is "not run" this time.
                    for (const t of list) reruns.get(t.id)!.push("not_run");
                    continue;
                }
                const job = ok(r, "Starting a rerun");
                await finished(job.jobId);
                const detail = await call("GET", `/api/projects/${project.id}/runs/${job.jobId}`, "Reading a rerun");
                const byId = new Map<string, { state: string; reason?: string }>((detail.tests ?? []).map((t: { id: string; state: string; reason?: string }) => [t.id, t]));
                for (const t of list) {
                    const got = byId.get(t.id);
                    reruns.get(t.id)!.push(toVerdict(got?.state));
                    if (got?.reason && got.state !== "passed") reasons.set(t.id, got.reason);
                }
            }

            // Coverage and duplicates from the tests' own steps (read through the test page's route).
            const pages = new Set<string>(phone ? (plan.phone?.screens ?? []).map((s: { title: string }) => s.title) : (plan.pages ?? []).map((p: { path: string }) => pathOf(p.path, "http://x") ?? p.path));
            const seenSteps = new Set<string>();
            const seenTitles = new Set<string>();
            const hit = new Set<string>();
            const duplicate = new Set<string>();
            const baseUrl = fixture.url ?? entry.url ?? "http://x";
            for (const t of list.slice(0, MAX_DETAILS)) {
                const d = await call("GET", `/api/tests/${t.id}`, "Reading a test");
                // Passed in the run that created it, after at least one repair (Auto-fix): with or without AI.
                if (Number(d.attempts) > 1 && firstOf.get(t.id)?.state === "passed") repairsFixed++;
                const spec = d.spec ?? {};
                if (phone) for (const name of String(spec.source?.journey ?? "").split(" → ")) if (pages.has(name.trim())) hit.add(name.trim());
                if (!phone) for (const s of (spec.steps ?? []) as Array<{ action?: string; url?: string }>) if (s.action === "navigate" && s.url) {
                    const p = pathOf(s.url, baseUrl);
                    if (p && pages.has(p)) hit.add(p);
                }
                const fp = fingerprint(spec.steps);
                const title = t.title.trim().toLowerCase();
                if (seenSteps.has(fp) || seenTitles.has(title)) duplicate.add(t.id);
                seenSteps.add(fp);
                seenTitles.add(title);
            }
            covered = hit.size;
            tests = list.map((t) => ({ id: t.id, testId: t.testId, title: t.title, firstRun: firstOf.has(t.id) ? toVerdict(firstOf.get(t.id)!.state) : null, reruns: reruns.get(t.id)!, reason: reasons.get(t.id), duplicate: duplicate.has(t.id) }));
        }

        // AI use, from the platform's usage records of the jobs that use the model (the reruns make no AI calls).
        let aiCalls = 0, inputTokens = 0, outputTokens = 0;
        let cost: number | null = null;
        const usage: UsageDetail = { cacheReadTokens: 0, cacheWriteTokens: 0, escalations: 0, byModel: [], repairsFixed, repairsWithoutAi: 0, pagesReused: 0 };
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
        for (const id of jobIds) {
            const u = await call("GET", `/api/jobs/${id}/usage`, "Reading AI usage");
            aiCalls += u.totals?.calls ?? 0;
            inputTokens += u.totals?.inputTokens ?? 0;
            outputTokens += u.totals?.outputTokens ?? 0;
            if (typeof u.totals?.cost === "number") cost = (cost ?? 0) + u.totals.cost;
            // Fields a platform without prompt caching, model routing or the savings without AI does not send count as zero.
            usage.cacheReadTokens += n(u.totals?.cacheReadTokens);
            usage.cacheWriteTokens += n(u.totals?.cacheWriteTokens);
            usage.escalations += n(u.totals?.escalations);
            usage.repairsWithoutAi += n(u.withoutAi?.repairs);
            usage.pagesReused += n(u.withoutAi?.pagesReused);
            for (const g of (Array.isArray(u.byModel) ? u.byModel : []) as Array<Record<string, unknown>>) {
                const model = String(g.key ?? "unknown").slice(0, 200);
                let row = usage.byModel.find((r) => r.model === model);
                if (!row && usage.byModel.length < 20) usage.byModel.push((row = { model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }));
                if (!row) continue;
                row.calls += n(g.calls);
                row.inputTokens += n(g.inputTokens);
                row.outputTokens += n(g.outputTokens);
                row.cacheReadTokens += n(g.cacheReadTokens);
            }
        }
        usage.repairsFixed = repairsFixed;

        const { metrics, tests: judged } = entryMetrics({
            planned: plan.total ?? 0,
            tests,
            coverageUnit: phone ? "screens" : "pages",
            found,
            covered,
            durationMs: Date.now() - t0,
            aiCalls,
            inputTokens,
            outputTokens,
            cost,
            safetyRefusals,
        });
        const rates = ratesOf(metrics);
        if (o.planOnly) rates.coverage = null;
        return { ...out, status: o.planOnly ? "planned" : "done", metrics, rates, ...(o.planOnly ? {} : { tests: judged }), usage };
    } catch (e) {
        if (active) await client.call("DELETE", `/api/test-generation/${active}`).catch(() => undefined);
        const reason = e instanceof Stopped || e instanceof ApiError || e instanceof Error ? e.message : String(e);
        return { ...out, status: "failed", reason: reason.slice(0, 1000) };
    }
}

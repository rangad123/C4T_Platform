/**
 * `node scripts/eval.mjs bench --mode repeat [options]`: the repeat-run benchmark (sheet #8 stage 1). It measures what an exploration of an
 * app the platform explored before costs, with reuse and the caches on against the same repeat with them off.
 *
 * Two arms, each on an in-process platform of its own (its own data folder) and the same model:
 *   on   reuse and caches on (ARMS.on.env); the repeat run is an ordinary exploration;
 *   off  reuse and caches off (ARMS.off.env); the repeat run also asks for everything to be explored again (`fullExploration`) without site memory.
 * A trial, per app and arm: the benchmark app starts fresh (its data reset, the understanding seed sent), a new project is made, and the
 * app is explored and planned twice in it through a loopback proxy (change-proxy.ts): the cold run, then the repeat run. Between them the
 * health checks are created from the cold run's plan (no AI), which is when the product keeps site memory (keepKnowledge). With a change
 * (the regression trial, the default), one page's HTML is changed between the two runs, and the repeat run must report it (its stored
 * model of that page differs from the cold run's). The arms alternate within every trial (on first in odd trials, off first in even ones).
 *
 * Measured per run from the platform's own records: wall time of the job, AI calls, input and output tokens, prompt-cache reads and
 * writes, cost (with a price table), pages found, test ideas planned, requirements covered and reuse events. report.ts turns them into
 * medians, ranges, savings and a verdict against the lead's targets. Nothing in the platform or the engine is told it is measured.
 *
 * Real model runs: one model on both arms (--single-model), a price table with a row for that model, an approved budget (the run stops
 * before an exploration once the priced usage has reached it) and a daily call cap. Tests use a scripted model (no key, no budget).
 * Exit codes: 0 every trial ran, 2 nothing could start, 3 the series is incomplete.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, type Config } from "../../../config.js";
import { EXTRACTION_LIMITS } from "../../../engine/intel/extract/rules.js";
import { LEVELS, type ExploreLevel } from "../../../engine/levels.js";
import type { LlmClient } from "../../../engine/llm/provider.js";
import type { AppModel } from "../../../engine/understanding/app-model.js";
import type { Platform } from "../../../platform/bootstrap.js";
import { loadStoredPlan } from "../../../platform/plan-store.js";
import { ok, type PlatformClient } from "../../client.js";
import { BENCH_APPS, BenchAppHost, benchApp, type BenchApp } from "../apps.js";
import { loadPrices } from "../cost.js";
import type { PriceRow } from "../schema.js";
import { INPUTS_DIR } from "../understanding/answer-key.js";
import { requirementsOf, seedApp } from "../understanding/run.js";
import { ChangeProxy, PAGE_CHANGES, type PageChange } from "./change-proxy.js";
import { buildRepeatReport, renderRepeatMd, type Arm, type RepeatTrial, type RunMetrics } from "./report.js";

/**
 * What differs between the arms: the platform's environment, and what the repeat run's exploration asks for. A saving added later (the
 * response cache, retrieval) adds its switch here, so the off arm keeps measuring everything off.
 */
export const ARMS: Record<Arm, { env: Record<string, string>; repeat: Record<string, unknown> }> = {
    on: { env: { LLM_PROMPT_CACHE: "true", LLM_EXPLORATION_REUSE: "true" }, repeat: {} },
    // Site memory is left out of the off arm's repeat as well: it explores as if the application were new.
    off: { env: { LLM_PROMPT_CACHE: "false", LLM_EXPLORATION_REUSE: "false" }, repeat: { fullExploration: true, useMemory: false } },
};

/** Events that say a run reused something (site memory, unchanged pages, probes, cached answers). */
export const REUSE_EVENTS = new Set(["memory_used", "understanding_reused", "probes_reused", "pages_from_memory", "signin_reused", "response_cache_hit"]);

export const REPEAT_USAGE = `Usage: node scripts/eval.mjs bench --mode repeat [options]
  --apps <id,id>             benchmark apps (default: ${BENCH_APPS.map((a) => a.id).join(", ")})
  --repeat <n>               trials per arm and app, 1 to 20 (default 5; fewer than 5 cannot be judged)
  --inputs <c>               full (the app's requirements document and OpenAPI description too, the default) or url (URL and sign-in only)
  --change <c>               page (one page changed between the cold run and the repeat run, the default) or none
  --level <l>                exploration level: ${LEVELS.join(", ")} (default: the platform's default)
  --port-base <n>            first port for the apps and their proxies (default 5391)
  --prices <file>            price table with a row for the model (required with a real model)
  --approved-budget-usd <n>  the most the run may spend (required with a real model); it stops before an exploration once reached
  --daily-call-cap <n>       stop before an exploration when the platforms made this many AI calls today (UTC); required with a real model
  --single-model             switch the fast and planning models off (required with a real model: one model on both arms)
  --estimate-only            print the estimate and stop (starts nothing)
  --out <dir>                where the results go (default eval/results/repeat)
  --data-dir <dir>           data folder for the two platforms (default a fresh folder under eval/.data-bench)
  --yes                      start at once (no 5 second wait)`;

export interface RepeatArgs {
    apps: string[];
    repeat: number;
    inputs: "full" | "url";
    change: "page" | "none";
    level?: ExploreLevel;
    portBase: number;
    prices?: string;
    budget?: number;
    dailyCallCap?: number;
    singleModel: boolean;
    estimateOnly: boolean;
    out: string;
    dataDir?: string;
    yes: boolean;
    help: boolean;
}

export function parseRepeatArgs(argv: string[]): RepeatArgs {
    const a: RepeatArgs = { apps: BENCH_APPS.map((x) => x.id), repeat: 5, inputs: "full", change: "page", portBase: 5391, singleModel: false, estimateOnly: false, out: "", yes: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]!;
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
            return v;
        };
        const whole = (min: number, max: number) => {
            const n = Number(value());
            if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be a whole number from ${min} to ${max}`);
            return n;
        };
        if (k === "--mode") {
            if (value() !== "repeat") throw new Error("--mode is repeat here");
        } else if (k === "--apps") a.apps = value().split(",").map((s) => s.trim()).filter(Boolean);
        else if (k === "--repeat") a.repeat = whole(1, 20);
        else if (k === "--inputs") {
            const v = value();
            if (v !== "full" && v !== "url") throw new Error("--inputs is full or url");
            a.inputs = v;
        } else if (k === "--change") {
            const v = value();
            if (v !== "page" && v !== "none") throw new Error("--change is page or none");
            a.change = v;
        } else if (k === "--level") {
            const l = value();
            if (!(LEVELS as readonly string[]).includes(l)) throw new Error(`--level is one of ${LEVELS.join(", ")}`);
            a.level = l as ExploreLevel;
        } else if (k === "--port-base") a.portBase = whole(1024, 65000);
        else if (k === "--prices") a.prices = path.resolve(value());
        else if (k === "--approved-budget-usd") {
            const n = Number(value());
            if (!Number.isFinite(n) || n < 0) throw new Error("--approved-budget-usd must be a number of dollars, 0 or more");
            a.budget = n;
        } else if (k === "--daily-call-cap") a.dailyCallCap = whole(1, 10_000_000);
        else if (k === "--single-model") a.singleModel = true;
        else if (k === "--estimate-only") a.estimateOnly = true;
        else if (k === "--out") a.out = path.resolve(value());
        else if (k === "--data-dir") a.dataDir = path.resolve(value());
        else if (k === "--yes") a.yes = true;
        else if (k === "--help" || k === "-h") a.help = true;
        else throw new Error(`Unknown option ${k}`);
    }
    if (a.dataDir && path.resolve(a.dataDir) === path.resolve(REPO_ROOT, "data")) throw new Error("--data-dir must not be the platform's own ./data folder");
    if (!a.out) a.out = path.join(REPO_ROOT, "eval/results", "repeat");
    return a;
}

/**
 * Upper bound of AI calls: per exploration the understanding and planning calls (about 8, cost.ts FIXED_CALLS) plus the application
 * analysis after it (at most EXTRACTION_LIMITS.maxCalls per source: the pages, and with full inputs the requirements and the API
 * description); two explorations per trial, arm and app.
 */
export function repeatEstimate(a: Pick<RepeatArgs, "apps" | "repeat" | "inputs">): { perExploration: number; total: number } {
    const perExploration = 8 + EXTRACTION_LIMITS.maxCalls * (a.inputs === "full" ? 3 : 1);
    return { perExploration, total: perExploration * 2 * 2 * a.repeat * a.apps.length };
}

/** What the page at `path` looks like in a stored model: its forms' fields and its controls. Undefined when the model has no such page. */
export function pageSignature(model: AppModel, pagePath: string): string | undefined {
    const page = model.pages.find((p) => (p.path.split("?")[0] || "/") === pagePath);
    if (!page) return undefined;
    return JSON.stringify({
        forms: page.forms.map((f) => ({ purpose: f.purpose, submit: f.submitLabel ?? "", fields: f.fields.map((x) => [x.name ?? "", x.label ?? "", x.type, Boolean(x.required)]) })),
        controls: page.components.map((c) => `${c.role}:${c.name}`).sort(),
    });
}

export interface RepeatDeps {
    /** Tests only: a scripted model for both platforms; then no price table, budget or cap is asked for. */
    makeLlm?: (config: Config) => LlmClient;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    pollMs?: number;
    /** Tests only: the apps and the requirements documents. */
    apps?: BenchApp[];
    inputsDir?: string;
    /** Tests only: more exploration options. */
    exploration?: Record<string, unknown>;
    jobTimeoutMs?: number;
}

interface Side {
    arm: Arm;
    client: PlatformClient;
    platform: Platform;
    stop: () => Promise<void>;
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JOB_DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

interface ProjectUsage {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number | null;
}

/** Today's AI use of one project (the exploration and the analysis after it are metered under the project). */
async function projectUsage(client: PlatformClient, projectId: string): Promise<ProjectUsage> {
    const d = today();
    const t = ok(await client.call("GET", `/api/usage?from=${d}&to=${d}&projectId=${encodeURIComponent(projectId)}`), "Reading the AI usage")?.totals ?? {};
    return { calls: Number(t.calls ?? 0), inputTokens: Number(t.inputTokens ?? 0), outputTokens: Number(t.outputTokens ?? 0), cacheReadTokens: Number(t.cacheReadTokens ?? 0), cacheWriteTokens: Number(t.cacheWriteTokens ?? 0), cost: typeof t.cost === "number" ? t.cost : null };
}

async function platformTotals(sides: Side[]): Promise<{ calls: number; cost: number }> {
    let calls = 0;
    let cost = 0;
    for (const s of sides) {
        const d = today();
        const u = await s.client.call("GET", `/api/usage?from=${d}&to=${d}`);
        calls += Number(u.body?.totals?.calls ?? 0);
        cost += Number(u.body?.totals?.cost ?? 0);
    }
    return { calls, cost };
}

/** Waits for a job to end; throws when it failed or took too long (it is stopped then). */
async function untilDone(client: PlatformClient, jobId: string, what: string, deps: RepeatDeps): Promise<void> {
    const end = Date.now() + (deps.jobTimeoutMs ?? 60 * 60_000);
    for (;;) {
        const job = ok(await client.call("GET", `/api/test-generation/${jobId}`), `Reading ${what}`) as { status: string; error?: string };
        if (job.status === "FAILED") throw new Error(`${what.charAt(0).toUpperCase()}${what.slice(1)} failed: ${job.error ?? "no reason given"}`);
        if (JOB_DONE.includes(job.status)) return;
        if (Date.now() > end) {
            await client.call("DELETE", `/api/test-generation/${jobId}`).catch(() => undefined);
            throw new Error(`${what.charAt(0).toUpperCase()}${what.slice(1)} took too long and was stopped.`);
        }
        await sleep(deps.pollMs ?? 1000);
    }
}

/**
 * The step between the runs that keeps what the cold run learned, as the product does: site memory is saved when tests are created from
 * a plan (an exploration that only plans saves none). The plan's ideas are left out and only the health checks are made (no AI), so this
 * costs no AI call; it is not part of either run's measures.
 */
async function keepKnowledge(side: Side, projectId: string, planJobId: string, ideas: string[], deps: RepeatDeps): Promise<void> {
    const off = Object.fromEntries(["accessibility", "securityChecks", "performanceChecks", "loadChecks", "inputChecks", "visionChecks", "contractChecks", "accessChecks", "visual"].map((k) => [k, false]));
    const started = ok(await side.client.call("POST", `/api/projects/${projectId}/plans/${planJobId}/create`, { targets: ["web"], excludeIdeas: ideas, healthChecks: true, ...off }), "Creating the health checks from the plan");
    await untilDone(side.client, String(started.jobId), "the creation from the plan", deps);
}

/** One exploration and plan of the project; its measures, the stored model, the job and its idea ids. */
async function exploreOnce(side: Side, projectId: string, body: Record<string, unknown>, deps: RepeatDeps): Promise<{ metrics: RunMetrics; model: AppModel; jobId: string; ideas: string[] }> {
    const { client, platform } = side;
    const before = await projectUsage(client, projectId);
    const t0 = Date.now();
    const started = ok(await client.call("POST", `/api/projects/${projectId}/test-generation`, body), "Starting the exploration");
    const jobId = String(started.jobId);
    await untilDone(client, jobId, "the exploration", deps);
    const clientMs = Date.now() - t0;
    const events = ok(await client.call("GET", `/api/test-generation/${jobId}/events`), "Reading the exploration's events") as Array<{ kind: string }>;
    // The analysis after the exploration is metered under the project, maybe a moment after the job ends: wait until it has settled.
    let after = await projectUsage(client, projectId);
    for (let i = 0; i < 20; i++) {
        await sleep(Math.min(deps.pollMs ?? 1000, 500));
        const again = await projectUsage(client, projectId);
        if (again.calls === after.calls) break;
        after = again;
    }
    const row = platform.repo.getJob(jobId);
    const wallMs = row?.startedAt && row.finishedAt ? Date.parse(row.finishedAt) - Date.parse(row.startedAt) : clientMs;
    const loaded = await loadStoredPlan(platform.repo, platform.store, jobId);
    if (!loaded.ok) throw new Error("The exploration kept no plan.");
    const model = loaded.plan.model as AppModel;
    const cost = after.cost === null ? null : after.cost - (before.cost ?? 0);
    return {
        model,
        jobId,
        ideas: loaded.plan.scenarios.map((x) => x.scenarioId),
        metrics: {
            wallMs,
            aiCalls: after.calls - before.calls,
            inputTokens: after.inputTokens - before.inputTokens,
            outputTokens: after.outputTokens - before.outputTokens,
            cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
            cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
            cost,
            pages: model.pages.length,
            scenarios: loaded.plan.scenarios.length,
            requirementsCovered: Number(row?.counters.requirementsCovered ?? 0),
            reuseEvents: events.filter((e) => REUSE_EVENTS.has(e.kind)).length,
        },
    };
}

async function runTrial(
    side: Side,
    o: { app: BenchApp; host: BenchAppHost; proxyPort: number; trial: number; args: RepeatArgs; requirementsText?: string; change?: PageChange; deps: RepeatDeps },
): Promise<RepeatTrial> {
    const { client } = side;
    const call = async (method: "GET" | "POST" | "PUT", url: string, what: string, body?: unknown) => ok(await client.call(method, url, body), what);
    const base: RepeatTrial = { app: o.app.id, arm: side.arm, trial: o.trial, status: "failed" };
    const account = o.app.understanding?.credentials ?? o.app.credentials;
    const proxy = new ChangeProxy(o.host.url, o.change);
    try {
        await o.host.start("none");
        await seedApp(o.host.url, account, o.app.understanding?.seed);
        await proxy.start(o.proxyPort);
        const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        const project = await call("POST", "/api/projects", "Creating the project", { name: `Repeat: ${o.app.id} ${side.arm} ${o.trial} (${stamp})`.slice(0, 120) });
        const projectId = String(project.id);
        if (o.args.inputs === "full") {
            await call("PUT", `/api/projects/${projectId}/app-details`, "Setting the application address", { webUrl: proxy.url });
            await call("PUT", `/api/projects/${projectId}/agent-inputs`, "Setting the API description", { openApiUrl: `${proxy.url}/openapi.json` });
            const requirements = requirementsOf(o.requirementsText ?? "");
            if (!requirements.length) throw new Error(`The requirements document of ${o.app.id} has no numbered requirement lines.`);
            await call("POST", `/api/projects/${projectId}/requirements/import`, "Importing the requirements", { requirements });
        }
        const exploration = {
            url: proxy.url,
            targets: ["web", "api"],
            plan: true,
            ...(o.args.level ? { level: o.args.level } : {}),
            ...(account ? { credentials: { username: account.username, password: account.password } } : {}),
            ...(o.deps.exploration ?? {}),
        };
        const cold = await exploreOnce(side, projectId, exploration, o.deps);
        await keepKnowledge(side, projectId, cold.jobId, cold.ideas, o.deps);
        proxy.changed = Boolean(o.change);
        const repeat = await exploreOnce(side, projectId, { ...exploration, ...ARMS[side.arm].repeat }, o.deps);
        proxy.changed = false;
        let change: RepeatTrial["change"];
        if (o.change) {
            const was = pageSignature(cold.model, o.change.path);
            const now = pageSignature(repeat.model, o.change.path);
            change = { id: o.change.id, applied: proxy.hits > 0, seen: was !== undefined && now !== was };
        }
        return { ...base, status: "completed", cold: cold.metrics, repeat: repeat.metrics, ...(change ? { change } : {}) };
    } catch (e) {
        return { ...base, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
    } finally {
        await proxy.stop().catch(() => undefined);
    }
}

export async function repeatMain(argv: string[], deps: RepeatDeps = {}): Promise<number> {
    const log = deps.log ?? ((s: string) => console.log(s));
    const env = deps.env ?? process.env;
    const scripted = Boolean(deps.makeLlm);
    let args: RepeatArgs;
    let apps: BenchApp[];
    let price: PriceRow[] | undefined;
    const docs = new Map<string, string>();
    try {
        args = parseRepeatArgs(argv);
        if (args.help) {
            log(REPEAT_USAGE);
            return 0;
        }
        const known = deps.apps ?? BENCH_APPS;
        apps = args.apps.map((id) => {
            const app = deps.apps ? known.find((x) => x.id === id) : benchApp(id);
            if (!app) throw new Error(`There is no benchmark app ${id} (known: ${known.map((x) => x.id).join(", ")})`);
            return app;
        });
        for (const app of apps) {
            if (args.change === "page" && !PAGE_CHANGES[app.id]) throw new Error(`There is no page change for ${app.id}; give --change none.`);
            if (args.inputs !== "full") continue;
            const file = path.join(deps.inputsDir ?? INPUTS_DIR, `${app.id}-requirements.md`);
            if (!fs.existsSync(file)) throw new Error(`The requirements document ${path.basename(file)} of ${app.id} is missing.`);
            docs.set(app.id, fs.readFileSync(file, "utf8"));
        }
        const est = repeatEstimate(args);
        log(`Arms: on (reuse and caches on) and off; ${args.repeat} trials per arm and app; apps: ${apps.map((a) => a.id).join(", ")}; inputs: ${args.inputs}; change: ${args.change}.`);
        log(`Estimate: at most ${est.total.toLocaleString("en-US")} AI calls (up to ${est.perExploration} per exploration, 4 explorations per trial and app).`);
        if (args.dailyCallCap !== undefined && est.total > args.dailyCallCap) log(`That is more than the daily cap of ${args.dailyCallCap}: the run stops at the cap and the series is reported incomplete.`);
        if (args.estimateOnly) return 0;
        if (!scripted) {
            if (!args.singleModel) throw new Error("A run with a real model uses one model on both arms: give --single-model.");
            if (!args.prices) throw new Error("Give --prices with a row for the model.");
            if (args.budget === undefined) throw new Error("Give --approved-budget-usd: the run stops before an exploration once its priced usage has reached it.");
            if (args.dailyCallCap === undefined) throw new Error("Give --daily-call-cap: the model's daily calls are shared with other runs.");
            price = loadPrices(args.prices);
        }
    } catch (e) {
        log(`${e instanceof Error ? e.message : String(e)}\n\n${REPEAT_USAGE}`);
        return 2;
    }

    const startedAt = new Date().toISOString();
    const dataDir = args.dataDir ?? path.join(REPO_ROOT, "eval/.data-bench", `repeat-${startedAt.slice(0, 19).replace(/[:T]/g, "-")}`);
    const { startPlatform } = await import("../cli.js");
    const sides: Side[] = [];
    const hosts = apps.map((app, i) => new BenchAppHost(app, args.portBase + i * 2));
    const trials: RepeatTrial[] = [];
    let model = "scripted";
    try {
        try {
            for (const arm of ["on", "off"] as const) {
                const p = await startPlatform(path.join(dataDir, arm), { ...env, ...ARMS[arm].env }, deps);
                sides.push({ arm, client: p.client, platform: p.platform, stop: p.stop });
            }
            if (!scripted) {
                const models = new Set<string>();
                for (const side of sides) {
                    ok(await side.client.call("PUT", "/api/llm/fast-model", { model: "" }), "Turning the fast model off");
                    ok(await side.client.call("PUT", "/api/llm/planning-model", { model: "" }), "Turning the planning model off");
                    const routing = ok(await side.client.call("GET", "/api/llm/fast-model"), "Reading which models are in use");
                    if (routing?.active || routing?.planning?.active) throw new Error(`The ${side.arm} arm would still use a second model.`);
                    models.add(String(routing?.mainModel ?? ""));
                }
                const cfg = ok(await sides[0]!.client.call("GET", "/api/config"), "Reading the platform's settings");
                if (!cfg?.llm?.configured) throw new Error("The benchmark needs an AI model. Set one up first (LLM_PROVIDER and its key in .env).");
                model = String(cfg.llm.model ?? "unknown");
                if (models.size !== 1 || !models.has(model)) throw new Error(`The two arms would use different models (${[...models].join(", ")}).`);
                const row = price!.find((p) => p.model === model);
                if (!row) throw new Error(`The price table has no row for ${model}.`);
                for (const side of sides) ok(await side.client.call("PUT", "/api/usage/prices", { model, inputPerMTok: row.inputPerMTok, outputPerMTok: row.outputPerMTok, ...(row.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: row.cachedInputPerMTok } : {}), ...(row.cacheWritePerMTok !== undefined ? { cacheWritePerMTok: row.cacheWritePerMTok } : {}) }), "Setting the model's price");
                if (!args.yes) {
                    log("Starting in 5 seconds. Press Ctrl+C to stop. (--yes starts at once.)");
                    await sleep(5000);
                }
            }
        } catch (e) {
            log(e instanceof Error ? e.message : String(e));
            return 2;
        }

        let stopped: string | undefined;
        for (let n = 1; n <= args.repeat && !stopped; n++) {
            for (const [i, app] of apps.entries()) {
                const order = n % 2 ? sides : [...sides].reverse();
                for (const side of order) {
                    if (!scripted) {
                        const t = await platformTotals(sides);
                        if (t.calls >= args.dailyCallCap!) stopped = `The daily call cap of ${args.dailyCallCap} was reached before ${app.id} ${side.arm} trial ${n}.`;
                        else if (t.cost >= args.budget!) stopped = `The approved budget of $${args.budget!.toFixed(2)} was reached before ${app.id} ${side.arm} trial ${n} ($${t.cost.toFixed(4)} spent).`;
                        if (stopped) break;
                    }
                    log(`${app.id} ${side.arm} trial ${n} of ${args.repeat}...`);
                    const change = args.change === "page" ? PAGE_CHANGES[app.id] : undefined;
                    const t = await runTrial(side, { app, host: hosts[i]!, proxyPort: args.portBase + i * 2 + 1, trial: n, args, ...(docs.has(app.id) ? { requirementsText: docs.get(app.id)! } : {}), ...(change ? { change } : {}), deps });
                    trials.push(t);
                    log(t.status === "completed" ? `  cold ${t.cold!.aiCalls} AI calls in ${t.cold!.wallMs} ms; repeat ${t.repeat!.aiCalls} AI calls in ${t.repeat!.wallMs} ms${t.change ? `; change ${t.change.applied ? (t.change.seen ? "reported" : "NOT reported") : "not applied"}` : ""}.` : `  failed: ${t.error}`);
                    fs.mkdirSync(path.join(args.out, "trials"), { recursive: true });
                    fs.writeFileSync(path.join(args.out, "trials", `${app.id}-${side.arm}-${n}.json`), JSON.stringify(t, null, 2));
                }
                if (stopped) break;
            }
        }
        if (stopped) log(stopped);

        const report = buildRepeatReport({ apps: apps.map((a) => a.id), trials, repeat: args.repeat });
        const complete = report.complete && !stopped && trials.length === args.repeat * apps.length * 2;
        const head = [
            `Model: ${model} (the same on both arms)`,
            `Arm on: ${Object.entries(ARMS.on.env).map(([k, v]) => `${k}=${v}`).join(", ")}. Arm off: ${Object.entries(ARMS.off.env).map(([k, v]) => `${k}=${v}`).join(", ")}; its repeat run explores everything again, without site memory.`,
            ...(args.change === "page" ? apps.map((a) => `${a.id}: between the cold run and the repeat run, ${PAGE_CHANGES[a.id]!.what.charAt(0).toLowerCase()}${PAGE_CHANGES[a.id]!.what.slice(1)}`) : ["No page was changed between the runs."]),
            ...(stopped ? [stopped] : []),
            "",
        ];
        const md = renderRepeatMd(report).replace(/\n\n/, `\n\n${head.join("\n")}\n`);
        fs.mkdirSync(args.out, { recursive: true });
        const stem = path.join(args.out, `${startedAt.slice(0, 16).replace("T", "-").replace(":", "")}-repeat${complete ? "" : "-partial"}`);
        fs.writeFileSync(`${stem}.json`, JSON.stringify({ format: 1, startedAt, finishedAt: new Date().toISOString(), model, arms: ARMS, options: { ...args, out: undefined, dataDir: undefined }, report, trials }, null, 2));
        fs.writeFileSync(`${stem}.md`, md);
        log(`Results: ${stem}.json`);
        log(`Verdict: ${report.verdict}`);
        return complete ? 0 : 3;
    } finally {
        for (const h of hosts) await h.stop?.().catch(() => undefined);
        for (const s of sides) await s.stop().catch(() => undefined);
    }
}

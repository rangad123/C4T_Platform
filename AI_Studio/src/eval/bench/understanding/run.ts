/**
 * `node scripts/eval.mjs bench --mode understanding [options]`: the understanding benchmark. For each trial, app and side it starts the
 * benchmark app fresh, creates a project on that side's own in-process platform (its own data folder), gives it the configuration's
 * inputs, explores and plans (nothing is generated or run), lets the analysis after the exploration build the application model, then
 * reruns the analysis once with nothing changed. The latest model version and its rules are scored against the app's answer key
 * (score.ts) and the series is reported per configuration (report.ts).
 *
 * Sides: "baseline" (Baseline-U) explores the way an older runner does and analyses without AI, from the URL and sign-in only, whatever
 * the input configuration; "candidate" is the current engine with the configuration's inputs. Sides alternate within every trial.
 * Configurations: "url" (URL and sign-in) and "full" (also the app's /openapi.json and its requirements document). A series never mixes
 * them. A run with a real model scores only against answer keys the owner approved, uses a free model only (--approved-budget-usd 0, a
 * price of 0 in --prices) and stops at --daily-call-cap. Exit codes: 0 every trial ran, 2 nothing could start, 3 the series is incomplete.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, type Config } from "../../../config.js";
import { EXTRACTION_LIMITS } from "../../../engine/intel/extract/rules.js";
import type { AppModel } from "../../../engine/intel/model.js";
import { LEVELS, type ExploreLevel } from "../../../engine/levels.js";
import type { LlmClient } from "../../../engine/llm/provider.js";
import { ok, type PlatformClient } from "../../client.js";
import { BENCH_APPS, BenchAppHost, benchApp, type BenchApp } from "../apps.js";
import { CATALOGUE_FILE, loadCatalogue, type Catalogue } from "../catalogue.js";
import { loadPrices } from "../cost.js";
import { ANSWERS_DIR, INPUTS_DIR, parseAnswerKey, requireApprovedKey, type AnswerKey } from "./answer-key.js";
import { buildReport, renderReportMd, type Engine, type Inputs, type TrialResult } from "./report.js";
import { scoreUnderstanding, type ScoredRule } from "./score.js";

export const UNDERSTANDING_USAGE = `Usage: node scripts/eval.mjs bench --mode understanding [options]
  --apps <id,id>             benchmark apps (default: ${BENCH_APPS.map((a) => a.id).join(", ")})
  --inputs <c>               url (URL and sign-in, the default) or full (also the app's OpenAPI document and requirements document)
  --engine <e>               baseline, candidate or both (default both, alternating within every trial)
  --repeat <n>               analyses per side and app, 1 to 20 (default 5)
  --level <l>                exploration level: ${LEVELS.join(", ")} (default: the platform's default)
  --port-base <n>            first port for the apps (default 5291)
  --prices <file>            price table (as for the detection benchmark); the model must be priced 0
  --approved-budget-usd <n>  must be 0: understanding runs use a free model only
  --daily-call-cap <n>       stop before a trial when the platforms have made this many AI calls today (UTC); required with a real model
  --single-model             switch the fast and planning models off on the benchmark's platforms (the main model does everything)
  --estimate-only            print the estimate and stop (starts nothing)
  --out <dir>                where the results go (default eval/results/understanding-<inputs>)
  --data-dir <dir>           data folder for the two platforms (default a fresh folder under eval/.data-bench)
  --yes                      start at once (no 5 second wait)`;

export interface UnderstandingArgs {
    apps: string[];
    inputs: Inputs;
    engines: Engine[];
    repeat: number;
    level?: ExploreLevel;
    portBase: number;
    prices?: string;
    budget?: number;
    dailyCallCap?: number;
    estimateOnly: boolean;
    /** The fast and planning models switched off on the benchmark's platforms: the main model does everything. */
    singleModel: boolean;
    out: string;
    dataDir?: string;
    yes: boolean;
    help: boolean;
}

export function parseUnderstandingArgs(argv: string[]): UnderstandingArgs {
    const a: UnderstandingArgs = { apps: BENCH_APPS.map((x) => x.id), inputs: "url", engines: ["baseline", "candidate"], repeat: 5, portBase: 5291, estimateOnly: false, singleModel: false, out: "", yes: false, help: false };
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
            if (value() !== "understanding") throw new Error("--mode is understanding here");
        } else if (k === "--apps") a.apps = value().split(",").map((s) => s.trim()).filter(Boolean);
        else if (k === "--inputs") {
            const v = value();
            if (v !== "url" && v !== "full") throw new Error("--inputs is url or full");
            a.inputs = v;
        } else if (k === "--engine") {
            const v = value();
            if (v !== "baseline" && v !== "candidate" && v !== "both") throw new Error("--engine is baseline, candidate or both");
            a.engines = v === "both" ? ["baseline", "candidate"] : [v];
        } else if (k === "--repeat") a.repeat = whole(1, 20);
        else if (k === "--level") {
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
        else if (k === "--estimate-only") a.estimateOnly = true;
        else if (k === "--single-model") a.singleModel = true;
        else if (k === "--out") a.out = path.resolve(value());
        else if (k === "--data-dir") a.dataDir = path.resolve(value());
        else if (k === "--yes") a.yes = true;
        else if (k === "--help" || k === "-h") a.help = true;
        else throw new Error(`Unknown option ${k}`);
    }
    if (a.dataDir && path.resolve(a.dataDir) === path.resolve(REPO_ROOT, "data")) throw new Error("--data-dir must not be the platform's own ./data folder");
    if (!a.out) a.out = path.join(REPO_ROOT, "eval/results", `understanding-${a.inputs}`);
    return a;
}

/**
 * Upper bounds of AI calls per analysis, from the engine's limits: the understanding and planning calls of the exploration (about 3), and on
 * the candidate side the page reading and, with `full`, the requirements reading (each at most EXTRACTION_LIMITS.maxCalls). The no-change
 * rerun reads nothing again.
 */
export function understandingEstimate(a: Pick<UnderstandingArgs, "apps" | "engines" | "repeat" | "inputs">): { perTrial: Record<Engine, number>; total: number } {
    const explore = 3;
    const perTrial: Record<Engine, number> = { baseline: explore, candidate: explore + EXTRACTION_LIMITS.maxCalls * (a.inputs === "full" ? 2 : 1) };
    const total = a.repeat * a.apps.length * a.engines.reduce((s, e) => s + perTrial[e], 0);
    return { perTrial, total };
}

export interface UnderstandingDeps {
    /** Tests only: a scripted model for both platforms; then no key needs approval and no budget is asked for. */
    makeLlm?: (config: Config) => LlmClient;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    pollMs?: number;
    /** Tests only: the apps, catalogue, answer keys and requirements documents. */
    apps?: BenchApp[];
    catalogueFile?: string;
    answersDir?: string;
    inputsDir?: string;
    /** Tests only: more exploration options. */
    exploration?: Record<string, unknown>;
    jobTimeoutMs?: number;
}

/** The numbered requirement lines of a requirements document ("- 4.9 text") as requirements to import. */
export function requirementsOf(text: string): Array<{ ref: string; title: string; description: string }> {
    return text.split(/\r?\n/).flatMap((line) => {
        const m = /^\s*[-*]\s+(\d{1,3}(?:\.\d{1,3}){1,3})\s+(.+)$/.exec(line);
        return m ? [{ ref: m[1]!, title: m[2]!.trim().slice(0, 200), description: m[2]!.trim() }] : [];
    });
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JOB_DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

/**
 * What the stored model shows about the discovery that fed it: pages carrying the newer page fields (field limits, patterns, options or
 * validation messages, dialogs, menus, tables, requests per interaction; forms themselves are older), and the older-runner sentence.
 */
export function discoveryOf(model: AppModel): { pages: number; pagesWithNewFields: number; olderRunnerNote: boolean } {
    const newerField = (f: AppModel["pages"][number]["forms"][number]["fields"][number]) => [f.min, f.max, f.minLength, f.maxLength, f.pattern, f.options, f.message].some((v) => v !== undefined);
    return {
        pages: model.pages.length,
        pagesWithNewFields: model.pages.filter((p) => p.structures.length > 0 || p.interactions.length > 0 || p.forms.some((f) => f.fields.some(newerField))).length,
        olderRunnerNote: model.missingContext.some((m) => /runner/i.test(m.text)),
    };
}

interface Side {
    engine: Engine;
    client: PlatformClient;
    stop: () => Promise<void>;
}

async function aiCallsOf(client: PlatformClient, projectId: string): Promise<{ calls: number; failedCalls: number }> {
    const d = today();
    const u = ok(await client.call("GET", `/api/usage?from=${d}&to=${d}&projectId=${encodeURIComponent(projectId)}`), "Reading the AI usage");
    return { calls: Number(u?.totals?.calls ?? 0), failedCalls: Number(u?.totals?.failedCalls ?? 0) };
}

async function callsToday(sides: Side[]): Promise<number> {
    let n = 0;
    for (const s of sides) {
        const d = today();
        const u = await s.client.call("GET", `/api/usage?from=${d}&to=${d}`);
        n += Number(u.body?.totals?.calls ?? 0);
    }
    return n;
}

async function runTrial(
    side: Side,
    o: { app: BenchApp; host: BenchAppHost; trial: number; inputs: Inputs; seeded: string[]; key: AnswerKey; keySha256: string; catalogueWorkflows: string[]; requirementsText?: string; level?: ExploreLevel; deps: UnderstandingDeps; log: (s: string) => void },
): Promise<{ result: TrialResult; detail: Record<string, unknown> }> {
    const { client, engine } = side;
    const call = async (method: "GET" | "POST" | "PUT", url: string, what: string, body?: unknown) => ok(await client.call(method, url, body), what);
    const base: TrialResult = { app: o.app.id, inputs: o.inputs, engine, trial: o.trial, status: "failed", counts: { aiCalls: 0, failedCalls: 0, pages: 0 } };
    let projectId: string | undefined;
    try {
        await o.host.start(o.seeded);
        const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        const project = await call("POST", "/api/projects", "Creating the project", { name: `Understanding: ${o.app.id} ${engine} ${o.trial} (${stamp})`.slice(0, 120) });
        projectId = String(project.id);
        // Baseline-U always has the URL and sign-in only; the candidate gets the configuration's inputs before it explores.
        if (engine === "candidate" && o.inputs === "full") {
            await call("PUT", `/api/projects/${projectId}/app-details`, "Setting the application address", { webUrl: o.host.url });
            await call("PUT", `/api/projects/${projectId}/agent-inputs`, "Setting the API description", { openApiUrl: `${o.host.url}/openapi.json` });
            const requirements = requirementsOf(o.requirementsText ?? "");
            if (!requirements.length) throw new Error(`The requirements document of ${o.app.id} has no numbered requirement lines.`);
            await call("POST", `/api/projects/${projectId}/requirements/import`, "Importing the requirements", { requirements });
        }
        const exploration = {
            url: o.host.url,
            targets: ["web", "api"],
            plan: true,
            ...(o.level ? { level: o.level } : {}),
            ...(o.app.credentials ? { credentials: { username: o.app.credentials.username, password: o.app.credentials.password } } : {}),
            ...(engine === "baseline" ? { understandingBaseline: true } : {}),
            ...(o.deps.exploration ?? {}),
        };
        const started = await call("POST", `/api/projects/${projectId}/test-generation`, "Starting the exploration", exploration);
        const jobId = String(started.jobId);
        const end = Date.now() + (o.deps.jobTimeoutMs ?? 60 * 60_000);
        let job: { status: string; error?: string };
        for (;;) {
            job = await call("GET", `/api/test-generation/${jobId}`, "Reading the exploration");
            if (JOB_DONE.includes(job.status)) break;
            if (Date.now() > end) {
                await client.call("DELETE", `/api/test-generation/${jobId}`).catch(() => undefined);
                throw new Error("The exploration took too long and was stopped.");
            }
            await sleep(o.deps.pollMs ?? 1000);
        }
        if (job.status === "FAILED") throw new Error(`The exploration failed: ${job.error ?? "no reason given"}`);
        const events = (await call("GET", `/api/test-generation/${jobId}/events`, "Reading the exploration's events")) as Array<{ kind: string; message?: string }>;
        const failedAnalysis = events.find((e) => e.kind === "analysis_failed");
        if (failedAnalysis) throw new Error(`The analysis failed: ${failedAnalysis.message ?? "no reason given"}`);
        const plan = await client.call("GET", `/api/projects/${projectId}/plans/${jobId}`);
        const pages = Number(plan.body?.found?.pages ?? 0);
        const version = await call("GET", `/api/projects/${projectId}/intel/models/latest`, "Reading the application model");
        const rules = (await call("GET", `/api/projects/${projectId}/intel/rules`, "Reading the rules")).rules as ScoredRule[];
        const usage = await aiCallsOf(client, projectId);

        // The no-change rerun: no new version and no AI call for sources that did not change.
        const versionsBefore = ((await call("GET", `/api/projects/${projectId}/intel/models`, "Reading the model versions")).versions as unknown[]).length;
        await call("POST", `/api/projects/${projectId}/intel/analyse`, "Analysing again with nothing changed");
        for (let i = 0; ; i++) {
            const s = await call("GET", `/api/projects/${projectId}/intel/sources`, "Reading the analysis state");
            if (!s.running) {
                if (s.last?.error) throw new Error(`The rerun failed: ${s.last.error}`);
                break;
            }
            if (i > 3600) throw new Error("The rerun did not finish.");
            await sleep(o.deps.pollMs ?? 1000);
        }
        const versionsAfter = ((await call("GET", `/api/projects/${projectId}/intel/models`, "Reading the model versions")).versions as unknown[]).length;
        const rulesAfter = (await call("GET", `/api/projects/${projectId}/intel/rules`, "Reading the rules")).rules as ScoredRule[];
        const usageAfter = await aiCallsOf(client, projectId);

        const model = version.model as AppModel;
        const score = scoreUnderstanding({
            model,
            rules,
            key: o.key,
            keySha256: o.keySha256,
            catalogueWorkflows: o.catalogueWorkflows,
            ...(o.requirementsText ? { requirementsText: o.requirementsText } : {}),
            incremental: { before: rules, after: rulesAfter, noChange: { newVersion: versionsAfter > versionsBefore, aiCallsForUnchangedSources: usageAfter.calls - usage.calls } },
        });
        return {
            result: { ...base, status: "completed", score, counts: { aiCalls: usage.calls, failedCalls: usage.failedCalls, pages } },
            detail: { projectId, jobId, modelVersion: version.version, sources: model.sources, discovery: discoveryOf(model), rules: rules.length, rerun: { versionsBefore, versionsAfter, aiCalls: usageAfter.calls - usage.calls } },
        };
    } catch (e) {
        const counts = projectId ? await aiCallsOf(client, projectId).catch(() => ({ calls: 0, failedCalls: 0 })) : { calls: 0, failedCalls: 0 };
        return { result: { ...base, error: (e instanceof Error ? e.message : String(e)).slice(0, 500), counts: { aiCalls: counts.calls, failedCalls: counts.failedCalls, pages: 0 } }, detail: { projectId } };
    }
}

export async function understandingMain(argv: string[], deps: UnderstandingDeps = {}): Promise<number> {
    const log = deps.log ?? ((s: string) => console.log(s));
    const env = deps.env ?? process.env;
    const scripted = Boolean(deps.makeLlm);
    let args: UnderstandingArgs;
    let apps: BenchApp[];
    let catalogue: Catalogue;
    const keys = new Map<string, { key: AnswerKey; sha256: string; file: string; requirementsText?: string }>();
    try {
        args = parseUnderstandingArgs(argv);
        if (args.help) {
            log(UNDERSTANDING_USAGE);
            return 0;
        }
        const known = deps.apps ?? BENCH_APPS;
        apps = args.apps.map((id) => {
            const app = deps.apps ? known.find((x) => x.id === id) : benchApp(id);
            if (!app) throw new Error(`There is no benchmark app ${id} (known: ${known.map((x) => x.id).join(", ")})`);
            return app;
        });
        catalogue = loadCatalogue(deps.catalogueFile ?? CATALOGUE_FILE);
        for (const app of apps) {
            const file = path.join(deps.answersDir ?? ANSWERS_DIR, `${app.id}.json`);
            if (!fs.existsSync(file)) throw new Error(`There is no answer key for ${app.id} (${path.basename(file)}).`);
            const { key, sha256 } = parseAnswerKey(fs.readFileSync(file, "utf8"), path.basename(file));
            if (key.app !== app.id) throw new Error(`${path.basename(file)} is the answer key of ${key.app}, not ${app.id}.`);
            if (key.catalogueVersion !== catalogue.version) throw new Error(`${path.basename(file)} was written against catalogue version ${key.catalogueVersion}, but the catalogue is ${catalogue.version}.`);
            const docFile = path.join(deps.inputsDir ?? INPUTS_DIR, key.requirementsDocument);
            const requirementsText = fs.existsSync(docFile) ? fs.readFileSync(docFile, "utf8") : undefined;
            if (args.inputs === "full" && requirementsText === undefined) throw new Error(`The requirements document ${key.requirementsDocument} of ${app.id} is missing.`);
            keys.set(app.id, { key, sha256, file: path.basename(file), ...(requirementsText !== undefined ? { requirementsText } : {}) });
        }
        const est = understandingEstimate(args);
        log(`Configuration: ${args.inputs}; sides: ${args.engines.join(", ")}; ${args.repeat} analyses per side and app; apps: ${apps.map((a) => a.id).join(", ")}.`);
        log(`Estimate: at most ${est.total.toLocaleString("en-US")} AI calls (${args.engines.map((e) => `${e} up to ${est.perTrial[e]} per analysis`).join(", ")}).`);
        if (args.dailyCallCap !== undefined && est.total > args.dailyCallCap) log(`That is more than the daily cap of ${args.dailyCallCap}: the run stops at the cap and the series is reported incomplete.`);
        if (args.estimateOnly) return 0;
        if (!scripted) {
            // A measured run: approved keys, a free model, a daily cap.
            for (const [, k] of keys) requireApprovedKey(k.key, k.file);
            if (args.budget !== 0) throw new Error("Understanding runs use a free model only: give --approved-budget-usd 0.");
            if (args.dailyCallCap === undefined) throw new Error("Give --daily-call-cap: the free model's daily calls are shared with other runs.");
            if (!args.prices) throw new Error("Give --prices with a row for the model at 0 and 0.");
        }
    } catch (e) {
        log(`${e instanceof Error ? e.message : String(e)}\n\n${UNDERSTANDING_USAGE}`);
        return 2;
    }

    const startedAt = new Date().toISOString();
    const dataDir = args.dataDir ?? path.join(REPO_ROOT, "eval/.data-bench", `understanding-${startedAt.slice(0, 19).replace(/[:T]/g, "-")}`);
    const { startPlatform } = await import("../cli.js");
    const sides: Side[] = [];
    const hosts = apps.map((app, i) => new BenchAppHost(app, args.portBase + i));
    const trials: TrialResult[] = [];
    const details: Array<Record<string, unknown>> = [];
    let model = "scripted";
    try {
        try {
            for (const engine of args.engines) {
                const p = await startPlatform(path.join(dataDir, engine), env, deps);
                sides.push({ engine, ...p });
            }
            if (!scripted) {
                const cfg = ok(await sides[0]!.client.call("GET", "/api/config"), "Reading the platform's settings");
                if (!cfg?.llm?.configured) throw new Error("The benchmark needs an AI model. Set one up first (LLM_PROVIDER and its key in .env).");
                model = String(cfg.llm.model ?? "unknown");
                const prices = loadPrices(args.prices!);
                const free = (m: string) => prices.some((p) => p.model === m && p.inputPerMTok === 0 && p.outputPerMTok === 0);
                if (!free(model)) throw new Error(`The model ${model} is not priced 0 in ${path.basename(args.prices!)}: understanding runs use a free model only.`);
                // Every model the run would use, on every side: with --single-model the fast and planning models are switched off first.
                for (const side of sides) {
                    if (args.singleModel) {
                        ok(await side.client.call("PUT", "/api/llm/fast-model", { model: "" }), "Turning the fast model off");
                        ok(await side.client.call("PUT", "/api/llm/planning-model", { model: "" }), "Turning the planning model off");
                    }
                    const routing = ok(await side.client.call("GET", "/api/llm/fast-model"), "Reading which models are in use");
                    const others = [routing?.active ? String(routing.entry || routing.model || "") : "", routing?.planning?.active ? String(routing.planning.entry || "") : ""].filter(Boolean);
                    for (const m of others) {
                        if (m !== model || !free(m)) throw new Error(`The ${side.engine} platform would also use the model ${m}, which is not the free model ${model}: understanding runs use a free model only. Give --single-model, or remove that model.`);
                    }
                }
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
                for (const side of sides) {
                    if (args.dailyCallCap !== undefined && (await callsToday(sides)) >= args.dailyCallCap) {
                        stopped = `The daily call cap of ${args.dailyCallCap} was reached before ${app.id} ${side.engine} trial ${n}.`;
                        break;
                    }
                    const k = keys.get(app.id)!;
                    log(`${app.id} ${side.engine} trial ${n} of ${args.repeat}...`);
                    const { result, detail } = await runTrial(side, {
                        app,
                        host: hosts[i]!,
                        trial: n,
                        inputs: args.inputs,
                        seeded: catalogue.defects.filter((d) => d.app === app.id).map((d) => d.id),
                        key: k.key,
                        keySha256: k.sha256,
                        catalogueWorkflows: [...new Set(catalogue.defects.filter((d) => d.app === app.id).map((d) => d.workflow))],
                        ...(args.inputs === "full" && k.requirementsText ? { requirementsText: k.requirementsText } : {}),
                        ...(args.level ? { level: args.level } : {}),
                        deps,
                        log,
                    });
                    trials.push(result);
                    details.push({ app: app.id, engine: side.engine, trial: n, ...detail });
                    log(result.status === "completed" ? `  ${result.counts.aiCalls} AI calls, ${result.counts.pages} pages.` : `  failed: ${result.error}`);
                    fs.mkdirSync(path.join(args.out, "trials"), { recursive: true });
                    fs.writeFileSync(path.join(args.out, "trials", `${app.id}-${side.engine}-${n}.json`), JSON.stringify({ result, detail }, null, 2));
                }
                if (stopped) break;
            }
        }
        if (stopped) log(stopped);

        const report = buildReport({ inputs: args.inputs, repeat: args.repeat, apps: apps.map((a) => a.id), trials, engines: args.engines });
        const head = [
            `Model: ${model}`,
            `Catalogue: ${catalogue.version} (${catalogue.sha256.slice(0, 12)})`,
            ...[...keys.values()].map((k) => `Answer key ${k.file}: version ${k.key.version}, ${k.key.review}, sha256 ${k.sha256.slice(0, 12)}`),
            "Baseline-U explores as an older runner does and analyses without AI, from the URL and sign-in only.",
            "U7 here is the no-change rerun only; carrying rule decisions forward and re-processing one changed source are not measured by this command.",
            ...(stopped ? [stopped] : []),
            "",
        ];
        const md = renderReportMd(report).replace(/\n\n/, `\n\n${head.join("\n")}\n`);
        fs.mkdirSync(args.out, { recursive: true });
        const stem = path.join(args.out, `${startedAt.slice(0, 16).replace("T", "-").replace(":", "")}-understanding-${args.inputs}${report.complete ? "" : "-partial"}`);
        fs.writeFileSync(`${stem}.json`, JSON.stringify({ format: 1, startedAt, finishedAt: new Date().toISOString(), model, options: { ...args, out: undefined, dataDir: undefined }, report, trials, details }, null, 2));
        fs.writeFileSync(`${stem}.md`, md);
        log(`Results: ${stem}.json`);
        return report.complete ? 0 : 3;
    } finally {
        for (const h of hosts) await h.stop?.().catch(() => undefined);
        for (const s of sides) await s.stop().catch(() => undefined);
    }
}

/**
 * `node scripts/eval.mjs bench [options]`: the seeded-defect benchmark (controller.ts) on a platform started in this process with a data
 * folder of its own (never ./data, never a running platform: the benchmark's data-changing work stays on its own apps and platform).
 * Writes `<out>/<date>-benchmark-<mode>.json` and `.md` (or, with --baseline and every app finished, the immutable `<out>/baseline.json`),
 * keeps the run on its own platform and, when AITP_EVAL_URL is set, also on that running platform (results only, for Settings, Quality).
 *
 * The AI model comes from .env as for the platform (nothing about it is built in). A paid run prints an estimate and refuses to start without
 * --approved-budget-usd and a price table for the model; a free model is priced 0 in the table and approved with --approved-budget-usd 0.
 * The state is saved after every app (`<out>/bench-state.json`): a run stopped by the provider's rate limit or the daily call cap is
 * continued with --resume, on the same platform data. Exit codes: 0 done, 2 nothing could start, 3 no app finished, 4 stopped (resume it).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, type Config } from "../../config.js";
import { LEVEL_SETTINGS, LEVELS, type ExploreLevel } from "../../engine/levels.js";
import type { LlmClient } from "../../engine/llm/provider.js";
import type { Platform } from "../../platform/bootstrap.js";
import { inProcessClient, ok, remoteClient, type PlatformClient } from "../client.js";
import type { EntryResult } from "../run.js";
import { appVersion, BENCH_APPS, benchApp, type BenchApp } from "./apps.js";
import { CATALOGUE_FILE, loadCatalogue } from "./catalogue.js";
import { plannedTestsLeft, runBenchmark, runUsageSoFar } from "./controller.js";
import { calibrationOf, estimate, estimateLines, loadPrices, tokenLimitsLeft } from "./cost.js";
import { engineVersion, promptFingerprints, writeBaseline } from "./record.js";
import { observedOf, trialProblem, withLabels } from "./observed.js";
import { benchMarkdown, observedMarkdown } from "./report.js";
import { BenchmarkSchema, type Benchmark, type BenchAppResult, type BenchConfig, type PriceRow } from "./schema.js";

export interface BenchDeps {
    /** Tests only: a scripted model for the in-process platform. Then no money is spent and no budget is asked for. */
    makeLlm?: (config: Config) => LlmClient;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    pollMs?: number;
    signal?: AbortSignal;
    /** Tests only: the catalogue file. */
    catalogueFile?: string;
    /** Tests only: the apps (with their scripts) instead of the shipped ones. */
    apps?: BenchApp[];
    root?: string;
    /** Tests only: more exploration options (to switch check families off around a stand-in app). */
    exploration?: Record<string, unknown>;
}

/** Every check family the platform has (server.ts GenerateSchema): --all-checks switches them all on. */
export const ALL_CHECKS = ["accessibility", "healthChecks", "securityChecks", "inputChecks", "contractChecks", "accessChecks", "performanceChecks", "loadChecks", "visual", "visionChecks"] as const;

export const BENCH_USAGE = `Usage: node scripts/eval.mjs bench [options]
  --apps <id,id>             benchmark apps (default: ${BENCH_APPS.map((a) => a.id).join(", ")})
  --mode <m>                 discovery (default: explore the app with the defects in) or regression (explore the correct app, run its tests with the defects in)
  --login <l>                how the apps' sign-in forms are sent: html (default) or js (a script-sent form; measured on its own, never part of the html baseline)
  --defects <id,id>          only these seeded behaviours (default: every one of the app)
  --level <l>                exploration level: ${LEVELS.join(", ")} (default: the platform's default)
  --allow-data-changes       let tests change data (only ever on the benchmark's own apps)
  --all-checks               every check family on (${ALL_CHECKS.join(", ")})
  --single-model             no fast model and no separate planning model: the main model does everything
  --max                      the deepest run: --level everything --allow-data-changes --all-checks --single-model
  --repeat <n>               reruns of every created test, 1 to 10 (default 1)
  --job-timeout-min <n>      longest the exploration, a creation and each replay job may take, in minutes (default 45)
  --isolated-replays         replay each finding alone, in a job of its own, on a freshly started app (every replay stage; slower, no AI)
  --port-base <n>            first port for the apps (default 5291)
  --prices <file>            price table: [{ "model", "inputPerMTok", "outputPerMTok", "cachedInputPerMTok"?, "cacheWritePerMTok"?, "note"? }] in US dollars
  --approved-budget-usd <n>  the most this run may spend (required with a real AI model; 0 for a free model); AI work stops at it
  --daily-call-cap <n>       stop when the benchmark's platform has made this many AI calls today (UTC); resume the next day
  --estimate-only            print the estimate and stop
  --labels <file>            { "<app>/<testKey>": "<defect id>" | "false_positive" } for findings the replays could not verify
  --baseline                 record the result as the immutable baseline (<out>/baseline.json; refused when one exists; only when every app finished)
  --resume                   continue the stopped run saved in <out>/bench-state.json (same options, same platform data)
  --out <dir>                where the results go (default eval/results/bench; other modes and --login js get their own folder:
                             eval/results/bench-regression, bench-login-js, bench-regression-login-js)
  --data-dir <dir>           data folder of the benchmark's platform (default a fresh folder under eval/.data-bench)
  --yes                      start at once (no 5 second wait)`;

interface Args {
    apps: string[];
    mode: "discovery" | "regression";
    login: "html" | "js";
    defects?: string[];
    level?: ExploreLevel;
    allowDataChanges: boolean;
    allChecks: boolean;
    singleModel: boolean;
    repeat: number;
    jobTimeoutMin?: number;
    isolatedReplays: boolean;
    portBase: number;
    prices?: string;
    budget?: number;
    dailyCallCap?: number;
    estimateOnly: boolean;
    labels?: string;
    baseline: boolean;
    resume: boolean;
    out: string;
    dataDir?: string;
    yes: boolean;
    help: boolean;
}

export function parseBenchArgs(argv: string[]): Args {
    const a: Args = { apps: BENCH_APPS.map((x) => x.id), mode: "discovery", login: "html", allowDataChanges: false, allChecks: false, singleModel: false, repeat: 1, isolatedReplays: false, portBase: 5291, estimateOnly: false, baseline: false, resume: false, out: "", yes: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]!;
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
            return v;
        };
        const list = () => value().split(",").map((s) => s.trim()).filter(Boolean);
        const whole = (min: number, max: number) => {
            const n = Number(value());
            if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be a whole number from ${min} to ${max}`);
            return n;
        };
        if (k === "--apps") a.apps = list();
        else if (k === "--login") {
            const l = value();
            if (l !== "html" && l !== "js") throw new Error("--login is html or js");
            a.login = l;
        } else if (k === "--mode") {
            const m = value();
            if (m !== "discovery" && m !== "regression") throw new Error("--mode is discovery or regression");
            a.mode = m;
        } else if (k === "--defects") a.defects = list();
        else if (k === "--level") {
            const l = value();
            if (!(LEVELS as readonly string[]).includes(l)) throw new Error(`--level is one of ${LEVELS.join(", ")}`);
            a.level = l as ExploreLevel;
        } else if (k === "--allow-data-changes") a.allowDataChanges = true;
        else if (k === "--all-checks") a.allChecks = true;
        else if (k === "--single-model") a.singleModel = true;
        else if (k === "--max") {
            a.level = "everything";
            a.allowDataChanges = a.allChecks = a.singleModel = true;
        } else if (k === "--repeat") a.repeat = whole(1, 10);
        else if (k === "--job-timeout-min") a.jobTimeoutMin = whole(1, 24 * 60);
        else if (k === "--isolated-replays") a.isolatedReplays = true;
        else if (k === "--port-base") a.portBase = whole(1024, 65000);
        else if (k === "--prices") a.prices = path.resolve(value());
        else if (k === "--approved-budget-usd") {
            const n = Number(value());
            if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error("--approved-budget-usd must be a number of dollars, 0 or more");
            a.budget = n;
        } else if (k === "--daily-call-cap") a.dailyCallCap = whole(1, 10_000_000);
        else if (k === "--estimate-only") a.estimateOnly = true;
        else if (k === "--labels") a.labels = path.resolve(value());
        else if (k === "--baseline") a.baseline = true;
        else if (k === "--resume") a.resume = true;
        else if (k === "--out") a.out = path.resolve(value());
        else if (k === "--data-dir") a.dataDir = path.resolve(value());
        else if (k === "--yes") a.yes = true;
        else if (k === "--help" || k === "-h") a.help = true;
        else throw new Error(`Unknown option ${k}`);
    }
    if (a.dataDir && path.resolve(a.dataDir) === path.resolve(REPO_ROOT, "data")) throw new Error("--data-dir must not be the platform's own ./data folder");
    if (!a.out) a.out = path.join(REPO_ROOT, "eval/results", defaultOutName(a.mode, a.login));
    return a;
}

/** Each kind of run keeps its results (and its baseline, state and calibration) in a folder of its own. */
export const defaultOutName = (mode: Args["mode"], login: Args["login"]): string => ["bench", ...(mode === "regression" ? ["regression"] : []), ...(login === "js" ? ["login-js"] : [])].join("-");

/**
 * The mode and sign-in of the benchmark results already in a folder, when they differ from this run's: results of different kinds must not
 * share a folder (the baseline, the resume state and the estimate's calibration are per folder).
 */
export function otherKindIn(dir: string, mode: Args["mode"], login: Args["login"]): string | undefined {
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
        return undefined;
    }
    for (const f of files) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            const o = j?.benchmark?.config?.options;
            if (!o) continue;
            const m = o.mode ?? j.benchmark.mode;
            const l = o.login ?? "html";
            if (m !== mode || l !== login) return `${f} (${m}, ${l} sign-in)`;
        } catch {
            /* not a result file */
        }
    }
    return undefined;
}

/** What --resume continues from: saved after every app. */
interface BenchState {
    format: 1;
    /** The options of the first attempt (a resume runs with them; only --yes, --approved-budget-usd and --daily-call-cap may change). */
    argv: string[];
    dataDir: string;
    startedAt: string;
    resumes: number;
    apps: BenchAppResult[];
    entries: EntryResult[];
    notes: string[];
}
const stateFile = (out: string) => path.join(out, "bench-state.json");

/**
 * The apps and entries to save after an app: the ones this attempt has reached, then the earlier attempt's apps it has not come to yet
 * (a stopped one with its project and jobs among them), so a kill half way through a resume loses none of them.
 */
export function withAppsNotReached<A extends { id: string }, E extends { id: string }>(now: { apps: A[]; entries: E[] }, earlier?: { apps: A[]; entries: E[] }): { apps: A[]; entries: E[] } {
    const later = (earlier?.apps ?? []).filter((a) => !now.apps.some((x) => x.id === a.id));
    const laterEntries = (earlier?.entries ?? []).filter((e) => later.some((a) => a.id === e.id) && !now.entries.some((x) => x.id === e.id));
    return { apps: [...now.apps, ...later], entries: [...now.entries, ...laterEntries] };
}

/** Save the resume state whole: written beside the file, then renamed over it, so a kill never leaves half a file. */
export function writeState(out: string, state: object): void {
    fs.mkdirSync(out, { recursive: true });
    const tmp = `${stateFile(out)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile(out));
}
const RESUME_MAY_CHANGE = new Set(["--yes", "--approved-budget-usd", "--daily-call-cap", "--resume", "--out"]);
/** Options that take no value. */
const FLAGS = new Set(["--allow-data-changes", "--isolated-replays", "--all-checks", "--single-model", "--max", "--estimate-only", "--baseline", "--resume", "--yes", "--help", "-h"]);
/** argv split into options, each with its value when it has one. */
function optionsOf(argv: string[]): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < argv.length; i++) out.push(FLAGS.has(argv[i]!) || i + 1 >= argv.length ? [argv[i]!] : [argv[i]!, argv[++i]!]);
    return out;
}
export const withoutOptions = (argv: string[], names: Set<string>): string[] => optionsOf(argv).filter((o) => !names.has(o[0]!)).flat();
export const onlyOptions = (argv: string[], names: Set<string>): string[] => optionsOf(argv).filter((o) => names.has(o[0]!)).flat();

/** A resume runs with the first attempt's options; only the few in RESUME_MAY_CHANGE are taken from the resume command. */
export function resumedArgs(firstArgv: string[], argv: string[]): Args {
    const first = withoutOptions(firstArgv, RESUME_MAY_CHANGE);
    const keep = onlyOptions(argv, RESUME_MAY_CHANGE).filter((x) => x !== "--resume");
    return { ...parseBenchArgs([...first, ...keep]), resume: true };
}

/**
 * The job time limit and isolated replays: what the run's config records (only when set, so a default run's config is what it was) and
 * what the controller is given.
 */
export function configLimits(a: Pick<Args, "jobTimeoutMin" | "isolatedReplays">): { options: Record<string, number | boolean>; run: { jobTimeoutMs?: number; isolatedReplays?: true } } {
    return {
        options: { ...(a.jobTimeoutMin !== undefined ? { jobTimeoutMin: a.jobTimeoutMin } : {}), ...(a.isolatedReplays ? { isolatedReplays: true } : {}) },
        run: { ...(a.jobTimeoutMin !== undefined ? { jobTimeoutMs: a.jobTimeoutMin * 60_000 } : {}), ...(a.isolatedReplays ? { isolatedReplays: true as const } : {}) },
    };
}

const slugDate = (iso: string) => iso.slice(0, 16).replace("T", "-").replace(":", "");

export async function benchMain(argv: string[], deps: BenchDeps = {}): Promise<number> {
    // The understanding benchmark (understanding/run.ts) has options and results of its own; the other modes are unchanged.
    const modeAt = argv.indexOf("--mode");
    if (modeAt >= 0 && argv[modeAt + 1] === "understanding") {
        const { understandingMain } = await import("./understanding/run.js");
        return understandingMain(argv, deps);
    }
    const log = deps.log ?? ((s: string) => console.log(s));
    const env = deps.env ?? process.env;
    const scripted = Boolean(deps.makeLlm);
    let args: Args;
    let apps: BenchApp[];
    let catalogue;
    let prices: PriceRow[] | undefined;
    let labels: Record<string, string> | undefined;
    let state: BenchState | undefined;
    try {
        args = parseBenchArgs(argv);
        if (args.help) {
            log(BENCH_USAGE);
            return 0;
        }
        if (args.resume) {
            if (!fs.existsSync(stateFile(args.out))) throw new Error(`There is no stopped run to resume in ${args.out} (bench-state.json).`);
            state = JSON.parse(fs.readFileSync(stateFile(args.out), "utf8")) as BenchState;
            // The first attempt's options, with the few a resume may change taken from this command.
            args = { ...resumedArgs(state.argv, argv), out: args.out };
        }
        const known = deps.apps ?? BENCH_APPS;
        apps = args.apps.map((id) => {
            const app = deps.apps ? known.find((x) => x.id === id) : benchApp(id);
            if (!app) throw new Error(`There is no benchmark app ${id} (known: ${known.map((x) => x.id).join(", ")})`);
            return app;
        });
        catalogue = loadCatalogue(deps.catalogueFile ?? CATALOGUE_FILE);
        if (args.defects) {
            const ids = new Set(catalogue.defects.map((d) => d.id));
            const unknown = args.defects.filter((d) => !ids.has(d));
            if (unknown.length) throw new Error(`The catalogue has no defect ${unknown.join(", ")}`);
        }
        if (args.prices) prices = loadPrices(args.prices);
        if (args.labels) labels = JSON.parse(fs.readFileSync(args.labels, "utf8")) as Record<string, string>;
        if (args.baseline && fs.existsSync(path.join(args.out, "baseline.json"))) throw new Error(`A baseline is already recorded in ${args.out}; it is never overwritten. Use another --out folder.`);
        if (!args.resume && fs.existsSync(stateFile(args.out))) throw new Error(`A stopped run is saved in ${args.out}: continue it with --resume, or use another --out folder.`);
        const other = otherKindIn(args.out, args.mode, args.login);
        if (other) throw new Error(`${args.out} holds results of another kind of run (${other}); this run (${args.mode}, ${args.login} sign-in) needs its own --out folder.`);
    } catch (e) {
        log(`${e instanceof Error ? e.message : String(e)}\n\n${BENCH_USAGE}`);
        return 2;
    }

    const limits = LEVEL_SETTINGS[args.level ?? "thorough"];
    const previous = previousCalibration(args.out);

    const startedAt = state?.startedAt ?? new Date().toISOString();
    const dataDir = state?.dataDir ?? args.dataDir ?? path.join(REPO_ROOT, "eval/.data-bench", slugDate(startedAt).replace(/:/g, ""));
    let stop: (() => Promise<void>) | undefined;
    const ac = new AbortController();
    deps.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const onSigint = () => {
        log("\nStopping: the job in progress is being stopped...");
        ac.abort();
    };
    process.once("SIGINT", onSigint);
    try {
        let client: PlatformClient;
        let config: BenchConfig;
        let model: string;
        try {
            if (env.AITP_EVAL_URL?.trim() && !scripted) log("The benchmark runs on a platform of its own; the result will also be kept on AITP_EVAL_URL.");
            const started = await startPlatform(dataDir, env, deps);
            stop = started.stop;
            client = started.client;
            const cfg = ok(await client.call("GET", "/api/config"), "Reading the platform's settings");
            // A scripted model (tests) is set on the platform directly, so the platform's settings do not name it.
            if (!scripted && !cfg?.llm?.configured) throw new Error("The benchmark needs an AI model. Set one up first (LLM_PROVIDER and its key in .env), then run this again.");
            model = scripted ? "scripted" : String(cfg.llm.model ?? "unknown");
            if (args.singleModel) {
                // Only on the benchmark's own platform: the main model plans, reviews and writes every step.
                ok(await client.call("PUT", "/api/llm/fast-model", { model: "" }), "Turning the fast model off");
                ok(await client.call("PUT", "/api/llm/planning-model", { model: "" }), "Turning the planning model off");
            }
            const fast = await client.call("GET", "/api/llm/fast-model");
            const fastModel = fast.status === 200 && fast.body?.active ? String(fast.body.entry || fast.body.model || "") || null : null;
            const planningModel = fast.status === 200 && fast.body?.planning?.active ? String(fast.body.planning.entry || "") || null : null;
            const eng = engineVersion(deps.root);
            const options: BenchConfig["options"] = {
                targets: "web,api",
                level: args.level ?? "platform default",
                login: args.login,
                allowMutatingApiTests: args.allowDataChanges,
                checks: args.allChecks ? "all" : "platform defaults",
                singleModel: args.singleModel,
                repeat: args.repeat,
                mode: args.mode,
                ...configLimits(args).options,
            };
            config = {
                engineCommit: eng.commit,
                engineDirty: eng.dirty,
                prompts: promptFingerprints(deps.root),
                model: { provider: scripted ? "scripted" : String(cfg.llm.provider ?? "unknown").slice(0, 80), model: model.slice(0, 200), fastModel, planningModel, temperature: "not set by the engine (provider default)" },
                catalogueVersion: `${catalogue.version} (${catalogue.sha256.slice(0, 12)})`,
                apps: apps.map((x) => ({ id: x.id, version: appVersion(x, deps.root) })),
                options,
                prices: prices ?? null,
                approvedBudget: args.budget ?? null,
                dailyCallCap: args.dailyCallCap ?? null,
                resumes: state ? state.resumes + 1 : 0,
                runtime: { node: process.version, platform: `${os.platform()}-${os.arch()}` },
            };
            // The estimate, before any AI work: finished apps cost nothing more; an app a stop interrupted is continued in its project, so
            // only its planned tests not made yet count; every other app is explored from the start.
            const continued: number[] = [];
            let fresh = 0;
            for (const a of apps) {
                const prev = state?.apps.find((x) => x.id === a.id);
                if (prev?.status === "done") continue;
                const left = prev?.status === "stopped" ? await plannedTestsLeft(client, prev) : undefined;
                if (left) {
                    continued.push(left.left);
                    log(`${a.id}: continued: ${left.planned} planned tests, ${left.made} made, ${left.skipped} skipped, ${left.left} still to make.`);
                } else fresh++;
            }
            const est = estimate({ apps: fresh, ...(continued.length ? { continued } : {}), maxScenarios: limits.maxScenarios, authoringMaxSteps: limits.authoringMaxSteps, ...(previous ? { previous } : {}) });
            const price = prices?.find((p) => p.model === model) ?? prices?.find((p) => model.endsWith(p.model) || p.model.endsWith(model));
            for (const line of estimateLines({ ...est, ...withCost(est, price) })) log(line);
            if (price?.note) log(`Price: ${price.note}.`);
            if (args.dailyCallCap !== undefined && est.mid.calls > args.dailyCallCap) log(`The likely ${est.mid.calls.toLocaleString("en-US")} calls are more than the daily cap of ${args.dailyCallCap}: the run will stop at the cap and continue with --resume.`);
            if (args.estimateOnly) return 0;
            if (!scripted) {
                if (!price) throw new Error(`A paid or free run needs a price for the model ${model}: give --prices with a row for it (0 and 0 for a free model).`);
                if (args.budget === undefined) throw new Error("This uses your AI model. Approve a budget first: --approved-budget-usd <dollars> (0 for a free model). The run stops when the estimated cost passes it.");
                const free = price.inputPerMTok === 0 && price.outputPerMTok === 0;
                if (!free && args.budget === 0) throw new Error(`The model ${model} is not free in the price table, so a budget of 0 allows nothing.`);
                ok(await client.call("PUT", "/api/usage/prices", { model, inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok, ...(price.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: price.cachedInputPerMTok } : {}), ...(price.cacheWritePerMTok !== undefined ? { cacheWritePerMTok: price.cacheWritePerMTok } : {}) }), "Setting the model's price");
                if (!free) {
                    // The budget is for the whole run, resumes included: what earlier attempts spent is taken off (in whatever month they ran),
                    // and the platform's monthly limit is this month's use so far plus what is left.
                    const used = state ? await runUsageSoFar(client, state.startedAt) : { cost: 0, monthUsedTokens: (await runUsageSoFar(client, new Date().toISOString())).monthUsedTokens };
                    const left = apps.filter((a) => state?.apps.find((x) => x.id === a.id)?.status !== "done").length;
                    ok(await client.call("PUT", "/api/usage/budgets", tokenLimitsLeft(args.budget, used.cost ?? 0, used.monthUsedTokens, left, price)), "Setting the token limits");
                    if (state && used.cost) log(`Earlier attempts of this run spent about $${used.cost.toFixed(2)} of the approved $${args.budget.toFixed(2)}.`);
                }
                log(free ? "Free model: the budget guard stays on (it stops at any cost above $0)." : `Approved budget $${args.budget.toFixed(2)}: AI work stops at it.`);
                if (!args.yes) {
                    log("Starting in 5 seconds. Press Ctrl+C to stop. (--yes starts at once.)");
                    for (let i = 0; i < 50 && !ac.signal.aborted; i++) await new Promise((r) => setTimeout(r, 100));
                    if (ac.signal.aborted) return 2;
                }
            }
        } catch (e) {
            log(e instanceof Error ? e.message : String(e));
            return 2;
        }

        const exploration: Record<string, unknown> = {
            targets: ["web", "api"],
            ...(args.level ? { level: args.level } : {}),
            ...(args.allowDataChanges ? { allowMutatingApiTests: true } : {}),
            ...(args.allChecks ? Object.fromEntries(ALL_CHECKS.map((c) => [c, true])) : {}),
            ...(deps.exploration ?? {}),
        };
        const firstArgv = state?.argv ?? argv;
        const { run, benchmark, complete } = await runBenchmark(client, {
            apps: apps.map((app, i) => ({ app, port: args.portBase + i })),
            catalogue,
            mode: args.mode,
            login: args.login,
            ...(args.defects ? { defects: args.defects } : {}),
            exploration,
            repeat: args.repeat,
            model,
            config,
            baseline: args.baseline,
            ...(labels ? { labels } : {}),
            ...(!scripted && args.budget !== undefined ? { budget: args.budget } : {}),
            ...(args.dailyCallCap !== undefined ? { dailyCallCap: args.dailyCallCap } : {}),
            ...(state ? { previous: { startedAt: state.startedAt, apps: state.apps, entries: state.entries, notes: state.notes } } : {}),
            onProgress: (s) => {
                const saved: BenchState = { format: 1, argv: firstArgv, dataDir, startedAt: s.startedAt, resumes: config.resumes, ...withAppsNotReached(s, state), notes: s.notes };
                writeState(args.out, saved);
            },
            signal: ac.signal,
            log,
            pollMs: deps.pollMs,
            ...configLimits(args).run,
        });

        const kept = await client.call("POST", "/api/eval/runs", run);
        if (kept.status !== 201) log(`The platform did not keep this run (${kept.body?.error ?? `HTTP ${kept.status}`}); the files below have it all.`);
        const remoteUrl = env.AITP_EVAL_URL?.trim();
        if (remoteUrl && !scripted) {
            const r = await remoteClient(remoteUrl, env.AITP_EVAL_API_KEY).call("POST", "/api/eval/runs", run).catch((e: unknown) => ({ status: 0, body: { error: String(e) } }));
            log(r.status === 201 ? `Kept on ${remoteUrl} too (Settings, Quality).` : `${remoteUrl} did not keep the run (${r.body?.error ?? `HTTP ${r.status}`}).`);
        }
        const text = JSON.stringify(run, null, 2);
        let file: string;
        if (args.baseline && complete) {
            const b = writeBaseline(args.out, text);
            file = b.file;
            fs.writeFileSync(path.join(args.out, "baseline.md"), benchMarkdown(benchmark, run), { flag: "wx" });
            log(`Baseline recorded: ${b.file} (sha256 ${b.sha256})`);
        } else {
            fs.mkdirSync(args.out, { recursive: true });
            let base = path.join(args.out, `${slugDate(run.finishedAt)}-benchmark-${args.mode}${complete ? "" : "-partial"}`);
            for (let n = 2; fs.existsSync(`${base}.json`); n++) base = path.join(args.out, `${slugDate(run.finishedAt)}-benchmark-${args.mode}${complete ? "" : "-partial"}-${n}`);
            fs.writeFileSync(`${base}.json`, text);
            fs.writeFileSync(`${base}.md`, benchMarkdown(benchmark, run));
            file = `${base}.json`;
            if (args.baseline) log("Not recorded as the baseline: not every app finished. Continue with --resume; the baseline is written when the run is complete.");
        }
        // A finished run needs no resume.
        if (complete && fs.existsSync(stateFile(args.out))) fs.renameSync(stateFile(args.out), path.join(args.out, `bench-state-${slugDate(run.finishedAt)}.done.json`));
        const m = benchmark.metrics;
        const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 1000) / 10}%`);
        log(`\nDetected ${m.detected} of ${m.seeded} seeded defects (${pct(m.detectionRate)}); precision ${pct(m.precision)}; ${m.falsePositives} false positives; reproduction ${pct(m.reproductionRate)}; ${m.aiCalls} AI calls${m.cost === null ? "" : `, about $${m.cost.toFixed(2)}`}.`);
        log(`Results: ${file}`);
        const stoppedApps = benchmark.apps.filter((a) => a.status === "stopped");
        if (stoppedApps.length) {
            log(`Stopped (${stoppedApps.map((a) => `${a.id}: ${a.reason ?? ""}`).join("; ")}). Continue with: node scripts/eval.mjs bench --resume --out ${args.out}`);
            return 4;
        }
        return benchmark.apps.some((a) => a.status === "done") ? 0 : 3;
    } finally {
        process.removeListener("SIGINT", onSigint);
        await stop?.().catch(() => undefined);
    }
}

function withCost(e: ReturnType<typeof estimate>, price: PriceRow | undefined) {
    const c = (p: { inputTokens: number; outputTokens: number }) => (price ? (p.inputTokens * price.inputPerMTok + p.outputTokens * price.outputPerMTok) / 1_000_000 : null);
    return { low: { ...e.low, cost: c(e.low) }, mid: { ...e.mid, cost: c(e.mid) }, high: { ...e.high, cost: c(e.high) } };
}

/**
 * Tokens per call and calls per test of the newest earlier benchmark result in this folder that has a usable record (calibrationOf: its
 * finished apps only, and never a record that counted fewer calls than tests), to calibrate the estimate.
 */
export function previousCalibration(dir: string): ReturnType<typeof calibrationOf> {
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("bench-state")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch {
        return undefined; // no folder yet
    }
    for (const f of files) {
        try {
            const c = calibrationOf(JSON.parse(fs.readFileSync(f, "utf8")));
            if (c) return c;
        } catch {
            /* not a result file */
        }
    }
    return undefined;
}

export async function startPlatform(dataDir: string, env: NodeJS.ProcessEnv, deps: BenchDeps): Promise<{ client: PlatformClient; platform: Platform; stop: () => Promise<void> }> {
    const { loadConfig } = await import("../../config.js");
    const { bootstrap } = await import("../../platform/bootstrap.js");
    const { buildServer } = await import("../../platform/server.js");
    const { Worker } = await import("../../platform/worker.js");
    fs.mkdirSync(dataDir, { recursive: true });
    // A platform of its own: no accounts (open mode), no shared key, and it runs the tests itself (the apps are on this computer).
    if (process.env.BLOCK_PRIVATE_TARGETS === "true") throw new Error("BLOCK_PRIVATE_TARGETS=true refuses loopback addresses, and the benchmark apps run on this computer. Run the benchmark without it.");
    const config = loadConfig({ ...env, DATA_DIR: dataDir, API_KEY: "", C4T_API_ORIGIN: "", C4T_SITE_URL: "", EXECUTION_MODE: "local" });
    const platform = bootstrap(config);
    if (deps.makeLlm) platform.llm = deps.makeLlm(config);
    const server = await buildServer(platform);
    const worker = new Worker({ ...platform, ...(deps.makeLlm ? { makeLlm: deps.makeLlm } : {}) }, deps.pollMs ?? 300);
    worker.start();
    return {
        client: inProcessClient(server, config.API_KEY),
        platform,
        stop: async () => {
            await worker.stop();
            await server.close();
            platform.db.close();
        },
    };
}

export const BENCH_REPORT_USAGE = `Usage: node scripts/eval.mjs bench-report --observed <results folder or file> [<more>...] [--labels <file>]
  Prints the "Observed vs captured" section (E1, E2 and every finding) of finished benchmark results; one folder or file per trial.
  Read-only: no platform, no app, no AI; nothing is written.
  --labels <file>   { "<app>/<testKey>": "<defect id>" | "false_positive" } for findings the replays could not verify`;

/** The one finished result a trial stands for: the file itself, or the single non-partial `*-benchmark-*.json` in the folder. */
function trialFile(target: string): string {
    if (!fs.existsSync(target)) throw new Error(`${target} does not exist: this trial is missing.`);
    if (fs.statSync(target).isFile()) return target;
    const finished = fs.readdirSync(target).filter((n) => /-benchmark-[a-z]+(-[a-z0-9-]+)?\.json$/.test(n) && !n.endsWith("-partial.json"));
    if (!finished.length) throw new Error(`No finished benchmark result in ${target}: this trial is missing (a -partial file is a stopped run, never counted). Finish it with --resume or leave the folder out.`);
    if (finished.length > 1) throw new Error(`${finished.length} finished benchmark results in ${target} (${finished.join(", ")}): name the file of the trial meant.`);
    return path.join(target, finished[0]!);
}

/** `bench-report --observed <folder>...`: read-only. Exit 0 printed, 2 a missing or unfinished trial, a bad file or bad options. */
export async function benchReportMain(argv: string[], deps: { log?: (line: string) => void } = {}): Promise<number> {
    const log = deps.log ?? ((s: string) => console.log(s));
    const targets: string[] = [];
    let labelsFile: string | undefined;
    let observed = false;
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]!;
        if (k === "--observed") observed = true;
        else if (k === "--labels") labelsFile = argv[++i];
        else if (k === "--help" || k === "-h") {
            log(BENCH_REPORT_USAGE);
            return 0;
        } else if (k.startsWith("--")) {
            log(`Unknown option ${k}.\n${BENCH_REPORT_USAGE}`);
            return 2;
        } else targets.push(path.resolve(k));
    }
    if (!observed || !targets.length) {
        log(BENCH_REPORT_USAGE);
        return 2;
    }
    try {
        const labels = labelsFile ? (JSON.parse(fs.readFileSync(labelsFile, "utf8")) as Record<string, string>) : undefined;
        const trials: Array<{ name: string; observed: ReturnType<typeof observedOf> }> = [];
        for (const t of targets) {
            const file = trialFile(t);
            const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { benchmark?: unknown };
            const parsed = BenchmarkSchema.safeParse(raw.benchmark);
            if (!parsed.success) throw new Error(`${file} is not a benchmark result: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
            const problem = trialProblem(parsed.data);
            if (problem) throw new Error(`${file}: ${problem}`);
            const b: Benchmark = labels ? withLabels(parsed.data, labels) : parsed.data;
            trials.push({ name: path.relative(process.cwd(), file) || file, observed: observedOf(b) });
        }
        log(observedMarkdown(trials));
        return 0;
    } catch (e) {
        log(e instanceof Error ? e.message : String(e));
        return 2;
    }
}

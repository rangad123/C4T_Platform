/**
 * `node scripts/eval.mjs [--corpus file] [--repeat N] [--only id,id] [--plan-only] [--fail-under stable=0.8,flaky=0.1] [--out dir] [--data-dir dir] [--yes]`
 *
 * Measures the AI tester on the corpus (eval/corpus.json by default), writes `<out>/<date>-<corpus>.json` and `.md`, keeps the run on the
 * platform (Settings, Quality) and compares it with the previous run of the same corpus. Exit codes: 0 done, 1 a quality gate failed,
 * 2 nothing could start (arguments, corpus, no AI model, platform not reachable), 3 no entry finished.
 *
 * The platform: a running one when AITP_EVAL_URL is set (with AITP_EVAL_API_KEY when it has a key), otherwise one started in this process
 * with its own data folder (eval/.data, never ./data).
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, type Config } from "../config.js";
import type { LlmClient } from "../engine/llm/provider.js";
import { inProcessClient, ok, remoteClient, type PlatformClient } from "./client.js";
import { loadCorpus, type Corpus } from "./corpus.js";
import { FixtureHost } from "./fixtures.js";
import { runCorpus } from "./harness.js";
import { checkGates, parseGates, type Gate } from "./metrics.js";
import { markdownSummary, type ComparisonView } from "./report.js";
import { compareMarkdown, compareRuns, DEFAULT_MARGINS, parseMargins, parseToggles, type Margins } from "./compare.js";
import type { EvalRun } from "./run.js";

export interface CliDeps {
    /** Tests only: the AI model the in-process platform uses (a scripted double). Real runs use the model configured in .env. */
    makeLlm?: (config: Config) => LlmClient;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    pollMs?: number;
    samplePort?: number;
    signal?: AbortSignal;
}

export const USAGE = `Usage: node scripts/eval.mjs [options]
  --corpus <file>        the corpus (default eval/corpus.json)
  --repeat <n>           reruns of every created test, 1 to 10 (default 3)
  --only <id,id>         only these entries
  --plan-only            explore and plan only: nothing is created or run (cheaper)
  --fail-under <gates>   e.g. stable=0.8,flaky=0.1 (exit code 1 when one fails); gates: stable, firstPass, coverage (at least), flaky, duplicates, testWrong (at most)
  --out <dir>            where the results go (default eval/results)
  --data-dir <dir>       data folder of the platform the harness starts (default eval/.data)
  --yes                  start at once (no 5 second wait after the cost warning)
  --compare              run the corpus twice, savings off then on, each on a platform of its own, and compare (a quality gate)
  --toggle <A,B=value>   with --compare: the settings that differ (default: every saving; a model setting takes =<model>)
  --max-quality-drop <m> with --compare: e.g. pass=2,false=0 (pass rate points, extra false failures; the defaults)
  --warm                 with --compare: explore and create each entry once first, not measured, so unchanged pages can be reused
Environment: AITP_EVAL_URL and AITP_EVAL_API_KEY to use a running platform instead of starting one (not with --compare).`;

interface Args {
    corpus: string;
    repeat: number;
    only?: string[];
    planOnly: boolean;
    gates?: Gate[];
    out: string;
    dataDir: string;
    yes: boolean;
    help: boolean;
    compare: boolean;
    toggle?: string;
    margins: Margins;
    warm: boolean;
}

export function parseArgs(argv: string[]): Args {
    const a: Args = { corpus: path.join(REPO_ROOT, "eval/corpus.json"), repeat: 3, planOnly: false, out: path.join(REPO_ROOT, "eval/results"), dataDir: path.join(REPO_ROOT, "eval/.data"), yes: false, help: false, compare: false, margins: { ...DEFAULT_MARGINS }, warm: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]!;
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
            return v;
        };
        if (k === "--corpus") a.corpus = path.resolve(value());
        else if (k === "--repeat") {
            const n = Number(value());
            if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("--repeat must be a whole number from 1 to 10");
            a.repeat = n;
        } else if (k === "--only") a.only = value().split(",").map((s) => s.trim()).filter(Boolean);
        else if (k === "--plan-only") a.planOnly = true;
        else if (k === "--fail-under") a.gates = parseGates(value());
        else if (k === "--out") a.out = path.resolve(value());
        else if (k === "--data-dir") a.dataDir = path.resolve(value());
        else if (k === "--yes") a.yes = true;
        else if (k === "--compare") a.compare = true;
        else if (k === "--toggle") a.toggle = value();
        else if (k === "--max-quality-drop") a.margins = parseMargins(value());
        else if (k === "--warm") a.warm = true;
        else if (k === "--help" || k === "-h") a.help = true;
        else throw new Error(`Unknown option ${k}`);
    }
    // The platform's own data folder is never used for evaluation projects.
    if (path.resolve(a.dataDir) === path.resolve(REPO_ROOT, "data")) throw new Error("--data-dir must not be the platform's own ./data folder");
    if (!a.compare && (a.toggle !== undefined || a.warm || argv.includes("--max-quality-drop"))) throw new Error("--toggle, --max-quality-drop and --warm only go with --compare");
    if (a.compare && a.gates) throw new Error("--fail-under does not go with --compare (the comparison has its own verdict, see --max-quality-drop)");
    return a;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "corpus";

/** `<dir>/<YYYY-MM-DD-HHmm>-<corpus>`, with -2, -3... when that name is taken. */
function resultBase(dir: string, run: EvalRun): string {
    const d = run.startedAt.slice(0, 16).replace("T", "-").replace(":", "");
    let base = path.join(dir, `${d}-${slug(run.corpus)}`);
    for (let n = 2; fs.existsSync(`${base}.json`); n++) base = path.join(dir, `${d}-${slug(run.corpus)}-${n}`);
    return base;
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
    const log = deps.log ?? ((s: string) => console.log(s));
    const env = deps.env ?? process.env;
    let args: Args;
    let corpus: Corpus;
    try {
        args = parseArgs(argv);
        if (args.help) {
            log(USAGE);
            return 0;
        }
        corpus = loadCorpus(args.corpus);
        const unknown = (args.only ?? []).filter((id) => !corpus.entries.some((e) => e.id === id));
        if (unknown.length) throw new Error(`The corpus has no entry ${unknown.join(", ")}`);
        if (!corpus.entries.length) throw new Error("The corpus has no entries. Add your apps to it (see eval/corpus.example.json).");
    } catch (e) {
        log(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
        return 2;
    }

    if (args.compare) return runCompare(args, corpus, deps, log, env);
    const remoteUrl = env.AITP_EVAL_URL?.trim();
    const fixtures = new FixtureHost({ mode: remoteUrl ? "remote" : "in-process", samplePort: deps.samplePort });
    const ac = new AbortController();
    const onSigint = () => {
        log("\nStopping: the job in progress is being stopped on the platform...");
        ac.abort();
    };
    deps.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    process.once("SIGINT", onSigint);
    let stopPlatform: (() => Promise<void>) | undefined;
    try {
        let client: PlatformClient;
        let model = "unknown";
        try {
            await fixtures.prepare(corpus);
            if (remoteUrl) client = remoteClient(remoteUrl, env.AITP_EVAL_API_KEY);
            else {
                // Only now: a remote run never loads the platform's code.
                const { loadConfig } = await import("../config.js");
                const { bootstrap } = await import("../platform/bootstrap.js");
                const { buildServer } = await import("../platform/server.js");
                const { Worker } = await import("../platform/worker.js");
                const config = loadConfig({ ...process.env, DATA_DIR: args.dataDir });
                const platform = bootstrap(config);
                if (deps.makeLlm) platform.llm = deps.makeLlm(config);
                const server = await buildServer(platform);
                const worker = new Worker({ ...platform, ...(deps.makeLlm ? { makeLlm: deps.makeLlm } : {}) }, deps.pollMs ?? 300);
                worker.start();
                stopPlatform = async () => {
                    await worker.stop();
                    await server.close();
                    platform.db.close();
                };
                client = inProcessClient(server, config.API_KEY);
            }
            const cfg = ok(await client.call("GET", "/api/config"), "Reading the platform's settings");
            if (!cfg?.llm?.configured) throw new Error("The evaluation needs an AI model. Set one up first (ANTHROPIC_API_KEY or another provider in .env, see the README), then run this again.");
            model = String(cfg.llm.model ?? "unknown");
        } catch (e) {
            log(e instanceof Error ? e.message : String(e));
            return 2;
        }

        const chosen = args.only?.length ? corpus.entries.filter((e) => args.only!.includes(e.id)) : corpus.entries;
        log(`Evaluating ${chosen.length} ${chosen.length === 1 ? "entry" : "entries"} of “${corpus.name}” with ${model}${args.planOnly ? " (plan only)" : `, ${args.repeat} reruns each`}.`);
        log("This uses your AI model and costs money: every entry explores and plans (and, unless --plan-only, creates tests), typically tens to a few hundred AI calls per entry. Set limits in Settings, AI usage.");
        if (!args.yes) {
            log("Starting in 5 seconds. Press Ctrl+C to stop. (--yes starts at once.)");
            for (let i = 0; i < 50 && !ac.signal.aborted; i++) await new Promise((r) => setTimeout(r, 100));
            if (ac.signal.aborted) return 2;
        }

        const run = await runCorpus(client, corpus, { repeat: args.repeat, planOnly: args.planOnly, only: args.only, fixtures, model, signal: ac.signal, log, env, pollMs: deps.pollMs });
        if (args.gates) run.gates = checkGates(run.overall.rates, args.gates);

        // Kept on the platform (Settings, Quality); it answers with the comparison with the previous run of this corpus.
        let comparison: ComparisonView | null = null;
        const kept = await client.call("POST", "/api/eval/runs", run);
        if (kept.status === 201) comparison = kept.body.comparison ?? null;
        else log(`The platform did not keep this run (${kept.body?.error ?? `HTTP ${kept.status}`}); the files below have it all.`);

        fs.mkdirSync(args.out, { recursive: true });
        const base = resultBase(args.out, run);
        fs.writeFileSync(`${base}.json`, JSON.stringify(run, null, 2));
        fs.writeFileSync(`${base}.md`, markdownSummary(run, comparison));

        const o = run.overall;
        const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 1000) / 10}%`);
        log(`\nDone: ${o.entriesDone} of ${o.entries} entries, ${o.created} tests created of ${o.planned} planned, first run ${pct(o.rates.firstPass)}, stable ${pct(o.rates.stable)}, flaky ${pct(o.rates.flaky)}, coverage ${pct(o.rates.coverage)}, ${o.aiCalls} AI calls.`);
        if (comparison) {
            const moved = comparison.overall.filter((c) => c.change === "better" || c.change === "worse");
            log(moved.length ? `Compared with the previous run: ${moved.map((c) => `${c.metric} ${c.change}`).join(", ")}.` : "Compared with the previous run: no measure moved.");
        }
        for (const g of run.gates ?? []) log(`Gate ${g.message}`);
        log(`Results: ${base}.json and ${base}.md`);
        if (o.entriesDone === 0) return 3;
        return run.gates?.some((g) => !g.passed) ? 1 : 0;
    } finally {
        process.removeListener("SIGINT", onSigint);
        await stopPlatform?.().catch(() => undefined);
        await fixtures.close();
    }
}

/** A platform started in this process with its own data folder and these settings on top of the environment (what --compare runs twice). */
async function startPlatform(dataDir: string, env: NodeJS.ProcessEnv, overrides: Record<string, string>, deps: CliDeps): Promise<{ client: PlatformClient; stop: () => Promise<void> }> {
    const { loadConfig } = await import("../config.js");
    const { bootstrap } = await import("../platform/bootstrap.js");
    const { buildServer } = await import("../platform/server.js");
    const { Worker } = await import("../platform/worker.js");
    const config = loadConfig({ ...env, ...overrides, DATA_DIR: dataDir });
    const platform = bootstrap(config);
    if (deps.makeLlm) platform.llm = deps.makeLlm(config);
    const server = await buildServer(platform);
    const worker = new Worker({ ...platform, ...(deps.makeLlm ? { makeLlm: deps.makeLlm } : {}) }, deps.pollMs ?? 300);
    worker.start();
    return {
        client: inProcessClient(server, config.API_KEY),
        stop: async () => {
            await worker.stop();
            await server.close();
            platform.db.close();
        },
    };
}

/**
 * `--compare`: the corpus with the savings off (baseline), then on (candidate), each on a fresh platform of its own (`<data-dir>/compare/<side>`,
 * emptied first, so no choice saved in an earlier run's Settings and no site memory carries over), then the comparison and its verdict
 * (compare.ts). Exit codes: 0 pass or not judged, 1 quality dropped, 2 nothing could start, 3 a side finished no entry.
 */
async function runCompare(args: Args, corpus: Corpus, deps: CliDeps, log: (s: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
    if (env.AITP_EVAL_URL?.trim()) {
        log("The comparison starts its own two platforms (one with the savings off, one with them on), so it cannot use a running platform. Unset AITP_EVAL_URL and run it again.");
        return 2;
    }
    let toggles;
    try {
        const parsed = parseToggles(args.toggle, env);
        toggles = parsed.toggles;
        for (const n of parsed.notes) log(n);
    } catch (e) {
        log(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
        return 2;
    }
    const startedAt = new Date().toISOString();
    const fixtures = new FixtureHost({ mode: "in-process", samplePort: deps.samplePort });
    const ac = new AbortController();
    const onSigint = () => {
        log("\nStopping: the job in progress is being stopped on the platform...");
        ac.abort();
    };
    deps.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    process.once("SIGINT", onSigint);
    const runs: EvalRun[] = [];
    let stop: (() => Promise<void>) | undefined;
    try {
        try {
            await fixtures.prepare(corpus);
        } catch (e) {
            log(e instanceof Error ? e.message : String(e));
            return 2;
        }
        const chosen = args.only?.length ? corpus.entries.filter((e) => args.only!.includes(e.id)) : corpus.entries;
        log(`Comparing ${chosen.length} ${chosen.length === 1 ? "entry" : "entries"} of “${corpus.name}” with the savings off and on: ${toggles.map((t) => t.label).join(", ")}.`);
        log("This runs the whole evaluation twice with your AI model and costs money (about twice a normal evaluation, more with --warm). Set limits in Settings, AI usage.");
        if (!args.yes) {
            log("Starting in 5 seconds. Press Ctrl+C to stop. (--yes starts at once.)");
            for (let i = 0; i < 50 && !ac.signal.aborted; i++) await new Promise((r) => setTimeout(r, 100));
            if (ac.signal.aborted) return 2;
        }
        for (const side of ["baseline", "candidate"] as const) {
            if (ac.signal.aborted) return 2;
            const dir = path.join(args.dataDir, "compare", side);
            // Only the comparison's own folder is emptied (never ./data: parseArgs refuses it as the data folder).
            fs.rmSync(dir, { recursive: true, force: true });
            const overrides = Object.fromEntries(toggles.map((t) => [t.name, side === "baseline" ? t.baseline : t.candidate]));
            log(`\n${side === "baseline" ? "Savings off (baseline)" : "Savings on (candidate)"}`);
            try {
                const started = await startPlatform(dir, env, overrides, deps);
                stop = started.stop;
                const cfg = ok(await started.client.call("GET", "/api/config"), "Reading the platform's settings");
                if (!cfg?.llm?.configured) throw new Error("The comparison needs an AI model. Set one up first (ANTHROPIC_API_KEY or another provider in .env, see the README), then run this again.");
                const model = String(cfg.llm.model ?? "unknown");
                runs.push(await runCorpus(started.client, corpus, { repeat: args.repeat, planOnly: args.planOnly, only: args.only, fixtures, model, signal: ac.signal, log, env, pollMs: deps.pollMs, warm: args.warm }));
            } catch (e) {
                log(e instanceof Error ? e.message : String(e));
                return 2;
            } finally {
                await stop?.().catch(() => undefined);
                stop = undefined;
            }
        }
        const report = compareRuns(runs[0]!, runs[1]!, { toggles, margins: args.margins, warm: args.warm, startedAt });
        fs.mkdirSync(args.out, { recursive: true });
        const base = resultBase(args.out, { ...runs[0]!, corpus: `${runs[0]!.corpus}-compare`, startedAt });
        fs.writeFileSync(`${base}.json`, JSON.stringify({ ...report, runs: { baseline: runs[0], candidate: runs[1] } }, null, 2));
        fs.writeFileSync(`${base}.md`, compareMarkdown(report));
        const d = report.difference;
        log(`\n${report.verdict === "pass" ? "Pass: quality held with the savings on." : report.verdict === "fail" ? "Fail: quality dropped with the savings on." : "Not judged."} Tokens ${d.totalTokens <= 0 ? "saved" : "added"}: ${Math.abs(d.totalTokens).toLocaleString("en-US")}${d.totalTokensPct === null ? "" : ` (${Math.abs(d.totalTokensPct)}%)`}; AI calls ${d.aiCalls <= 0 ? "fewer" : "more"}: ${Math.abs(d.aiCalls)}.`);
        for (const r of report.reasons) log(`  ${r}`);
        log(`Results: ${base}.json and ${base}.md`);
        if (report.baseline.entriesDone === 0 || report.candidate.entriesDone === 0) return 3;
        return report.verdict === "fail" ? 1 : 0;
    } finally {
        process.removeListener("SIGINT", onSigint);
        await stop?.().catch(() => undefined);
        await fixtures.close();
    }
}

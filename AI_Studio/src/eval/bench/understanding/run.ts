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
 * them. With full, the requirements document is imported one record per numbered requirement (the default, --doc records) or uploaded whole
 * as one record (--doc whole); the report says which. Recorded judgements (--judgements, one trial's or a list) are applied to the trial
 * they were recorded for. The understanding settings of a benchmark app (apps.ts) give its crawl another account, seed data the pages need
 * before the crawl, and name the answer-key screens no crawl can reach. A run with a real model scores only against answer keys the owner approved, uses a free model only (--approved-budget-usd 0, a
 * price of 0 in --prices) and stops at --daily-call-cap. Exit codes: 0 every trial ran, 2 nothing could start, 3 the series is incomplete.
 */
import { randomUUID } from "node:crypto";
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
import { MAX_TEXT } from "../../../platform/requirement-store.js";
import { AppAnalysis, gatherAnalysisInputs, REQUIREMENTS_REF, type AnalysisResult } from "../../../platform/app-analysis.js";
import type { Platform } from "../../../platform/bootstrap.js";
import { usageStoreFor } from "../../../platform/usage-store.js";
import { JobMeter } from "../../../engine/llm/metered.js";
import { ANSWERS_DIR, INPUTS_DIR, parseAnswerKey, parseJudgements, requireApprovedKey, type AnswerKey, type Judgements } from "./answer-key.js";
import { buildReport, renderReportMd, type CallsByPurpose, type DocVariant, type Engine, type Inputs, type TrialResult } from "./report.js";
import { PAID_KEY_ENV, PAID_MODEL, paidKeyFrom, paidLlm, paidPlatformEnv, paidPricesIn, SpendGuard, type PaidPrices } from "./paid.js";
import { scoreUnderstanding, type ScoredRule } from "./score.js";

export const UNDERSTANDING_USAGE = `Usage: node scripts/eval.mjs bench --mode understanding [options]
  --apps <id,id>             benchmark apps (default: ${BENCH_APPS.map((a) => a.id).join(", ")})
  --inputs <c>               url (URL and sign-in, the default) or full (also the app's OpenAPI document and requirements document)
  --doc <d>                  with full: records (one requirement record per numbered line, the default) or whole (the whole document
                             as one record, headings and context kept)
  --judgements <file>        recorded judgements (one trial's, or a list) applied to the trials they were recorded for
  --engine <e>               baseline, candidate or both (default both, alternating within every trial)
  --repeat <n>               analyses per side and app, 1 to 20 (default 5)
  --level <l>                exploration level: ${LEVELS.join(", ")} (default: the platform's default)
  --port-base <n>            first port for the apps (default 5291)
  --prices <file>            price table: the free model's rows (as for the detection benchmark, priced 0), or the paid table
                             eval/bench-prices-claude.json (claude-haiku-5-5 on both sides, low effort, key from BENCH_ANTHROPIC_API_KEY)
  --approved-budget-usd <n>  0 with the free model; above 0 only with the paid table: the run stops before a call could pass it
  --daily-call-cap <n>       stop before a trial when the platforms have made this many AI calls today (UTC); required with a real model
  --single-model             switch the fast and planning models off on the benchmark's platforms (the main model does everything)
  --estimate-only            print the estimate and stop (starts nothing)
  --out <dir>                where the results go (default eval/results/understanding-<inputs>)
  --data-dir <dir>           data folder for the two platforms (default a fresh folder under eval/.data-bench)
  --yes                      start at once (no 5 second wait)`;

export interface UnderstandingArgs {
    apps: string[];
    inputs: Inputs;
    /** How a full series gives the requirements document. */
    doc: DocVariant;
    /** A file of recorded judgements. */
    judgements?: string;
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
    const a: UnderstandingArgs = { apps: BENCH_APPS.map((x) => x.id), inputs: "url", doc: "records", engines: ["baseline", "candidate"], repeat: 5, portBase: 5291, estimateOnly: false, singleModel: false, out: "", yes: false, help: false };
    let docGiven = false;
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
        } else if (k === "--doc") {
            const v = value();
            if (v !== "records" && v !== "whole") throw new Error("--doc is records or whole");
            a.doc = v;
            docGiven = true;
        } else if (k === "--judgements") a.judgements = path.resolve(value());
        else if (k === "--engine") {
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
    if (docGiven && a.inputs !== "full") throw new Error("--doc needs --inputs full (only a full series gives the requirements document)");
    if (a.dataDir && path.resolve(a.dataDir) === path.resolve(REPO_ROOT, "data")) throw new Error("--data-dir must not be the platform's own ./data folder");
    if (!a.out) a.out = path.join(REPO_ROOT, "eval/results", `understanding-${a.inputs}`);
    return a;
}

/**
 * Upper bounds of AI calls per analysis, from the engine's limits: the understanding and planning calls of the exploration (about 3), and on
 * the candidate side the page reading and, with `full`, the requirements reading (each at most EXTRACTION_LIMITS.maxCalls), read once more
 * after one requirement is edited (U7). The no-change rerun reads nothing again.
 */
export function understandingEstimate(a: Pick<UnderstandingArgs, "apps" | "engines" | "repeat" | "inputs">): { perTrial: Record<Engine, number>; total: number } {
    const explore = 3;
    const perTrial: Record<Engine, number> = { baseline: explore, candidate: explore + EXTRACTION_LIMITS.maxCalls * (a.inputs === "full" ? 3 : 1) };
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
    /** Tests only: what the paid series' model client sends its requests to, instead of the provider. */
    anthropicFetch?: typeof fetch;
}

/** The numbered requirement lines of a requirements document ("- 4.9 text") as requirements to import. */
export function requirementsOf(text: string): Array<{ ref: string; title: string; description: string }> {
    return text.split(/\r?\n/).flatMap((line) => {
        const m = /^\s*[-*]\s+(\d{1,3}(?:\.\d{1,3}){1,3})\s+(.+)$/.exec(line);
        return m ? [{ ref: m[1]!, title: m[2]!.trim().slice(0, 200), description: m[2]!.trim() }] : [];
    });
}

/**
 * The whole requirements document as one requirement record: titled by its first line (a heading's "#" dropped), every later line kept in
 * order. A record's description holds at most `limit` characters, so whole lines past it continue in its acceptance criteria (the
 * analysis reads both as one document); a document longer than both is refused.
 */
export function wholeDocumentRequirement(text: string, limit = MAX_TEXT): { ref: string; title: string; description: string; acceptanceCriteria: string } {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const title = (lines.shift() ?? "").replace(/^#+\s*/, "").trim().slice(0, 200) || "Requirements";
    while (lines.length && !lines[0]!.trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    let n = 0;
    while (n < lines.length && lines.slice(0, n + 1).join("\n").length <= limit) n++;
    const description = lines.slice(0, n).join("\n");
    const acceptanceCriteria = lines.slice(n).join("\n");
    if ((n === 0 && lines.length > 0) || acceptanceCriteria.length > limit) throw new Error(`The requirements document is too long to upload whole (at most ${limit * 2} characters in whole lines).`);
    return { ref: "requirements", title, description, acceptanceCriteria };
}

/** A judgements file: one trial's judgements or a list. Each must name an app of the run, its answer key as scored, and this configuration. */
export function loadJudgements(file: string, o: { inputs: Inputs; keys: Map<string, string> }): Judgements[] {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        throw new Error(`The judgements file ${path.basename(file)} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const list = (Array.isArray(raw) ? raw : [raw]).map((x) => parseJudgements(JSON.stringify(x)));
    const seen = new Set<string>();
    for (const j of list) {
        const sha = o.keys.get(j.app);
        if (sha === undefined) throw new Error(`The judgements file has judgements for ${j.app}, which this run does not analyse.`);
        if (j.answerKeySha256 !== sha) throw new Error(`The judgements for ${j.app} trial ${j.trial} were recorded against another version of the answer key.`);
        if (j.inputs !== o.inputs) throw new Error(`The judgements for ${j.app} trial ${j.trial} were recorded for a ${j.inputs} series; this series is ${o.inputs}.`);
        const id = `${j.app} ${j.engine} trial ${j.trial}`;
        if (seen.has(id)) throw new Error(`The judgements file has ${id} twice.`);
        seen.add(id);
    }
    return list;
}

/** The judgements recorded for one trial, applied only to the model version they were recorded for. */
export function judgementFor(list: Judgements[], t: { app: string; engine: Engine; trial: number; modelVersion: number }): { judgements?: Judgements; note?: string } {
    const j = list.find((x) => x.app === t.app && x.engine === t.engine && x.trial === t.trial);
    if (!j) return {};
    if (j.modelVersion !== t.modelVersion) return { note: `The judgements for this trial were recorded for model version ${j.modelVersion}, not ${t.modelVersion}: not applied.` };
    return { judgements: j };
}

/** AI calls by purpose (the usage groups by purpose): analysis is reading the application, planning is the exploration's planning. */
export function callsByPurpose(groups: Array<{ key: string; calls: number }>): CallsByPurpose {
    const out: CallsByPurpose = { analysis: 0, planning: 0, other: 0 };
    for (const g of groups) out[g.key === "analysis" || g.key === "planning" ? g.key : "other"] += Number(g.calls ?? 0);
    return out;
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
    /** Runs the project's analysis again in this process (analyserOf). */
    analyse: (projectId: string) => Promise<AnalysisResult>;
}

/**
 * The analysis run again for U7, in this process, on the side's own model client (the paid series' guarded client, a test's scripted
 * model, or the server's own), metered under the project like the analysis the API starts. The API's analysis uses the starter's chosen
 * key (ai-config.ts), and the benchmark's platforms hold no key in the paid series: started from the API, a rerun could never read with
 * AI, so a changed source would not be read again and "nothing read" would prove nothing. This runs the same analysis code
 * (gatherAnalysisInputs, AppAnalysis.run) with a key.
 */
function analyserOf(p: Platform): (projectId: string) => Promise<AnalysisResult> {
    return async (projectId) => {
        const usable = p.llm.modelName !== "unavailable";
        const meter = usable ? new JobMeter({ backend: usageStoreFor(p.db, p.config), jobId: `analysis-${randomUUID()}`, projectId }) : undefined;
        try {
            const inputs = await gatherAnalysisInputs(p, projectId);
            return await new AppAnalysis({ sql: p.sql, store: p.store }).run(projectId, inputs, meter ? { llm: meter.wrap(p.llm) } : { noAi: "no AI model is set up for this work." });
        } finally {
            meter?.finish();
        }
    };
}

/** The suffix the U7 edit appends to a requirement in the copy of the document. */
export const EDIT_MARK = " (wording edited)";

/** A copy of the requirements document with its last numbered requirement line edited (EDIT_MARK appended); the ref of that line. */
export function editedCopy(text: string): { text: string; edited: string } | undefined {
    const lines = text.split(/(?<=\n)/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^(\s*[-*]\s+(\d{1,3}(?:\.\d{1,3}){1,3})\s+.*?)(\r?\n)?$/.exec(lines[i]!);
        if (!m) continue;
        lines[i] = `${m[1]}${EDIT_MARK}${m[3] ?? ""}`;
        return { text: lines.join(""), edited: m[2]! };
    }
    return undefined;
}

async function aiCallsOf(client: PlatformClient, projectId: string): Promise<{ calls: number; failedCalls: number; byPurpose: CallsByPurpose }> {
    const d = today();
    const u = ok(await client.call("GET", `/api/usage?from=${d}&to=${d}&projectId=${encodeURIComponent(projectId)}&groupBy=purpose`), "Reading the AI usage");
    return { calls: Number(u?.totals?.calls ?? 0), failedCalls: Number(u?.totals?.failedCalls ?? 0), byPurpose: callsByPurpose(Array.isArray(u?.groups) ? u.groups : []) };
}

/** Sends the app's understanding seed requests as the crawl's account (signed in through the app's JSON sign-in). */
async function seedApp(url: string, account: { username: string; password: string } | undefined, seed: NonNullable<BenchApp["understanding"]>["seed"] = []): Promise<void> {
    if (!seed.length) return;
    if (!account) throw new Error("The app's seed data needs a sign-in, and the app has none.");
    const send = (method: string, p: string, body: unknown, cookie?: string) =>
        fetch(`${url}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const login = await send("POST", "/api/login", { email: account.username, password: account.password });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    if (!login.ok || !cookie) throw new Error(`Signing in to seed the app's data failed (HTTP ${login.status}).`);
    for (const s of seed) {
        const r = await send(s.method, s.path, s.body, cookie);
        if (!r.ok) throw new Error(`Seeding the app's data failed: ${s.method} ${s.path} answered HTTP ${r.status}.`);
    }
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
    o: { app: BenchApp; host: BenchAppHost; trial: number; inputs: Inputs; doc: DocVariant; judgements: Judgements[]; seeded: string[]; key: AnswerKey; keySha256: string; catalogueWorkflows: string[]; requirementsText?: string; level?: ExploreLevel; out: string; deps: UnderstandingDeps; log: (s: string) => void },
): Promise<{ result: TrialResult; detail: Record<string, unknown> }> {
    const { client, engine } = side;
    const call = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, what: string, body?: unknown) => ok(await client.call(method, url, body), what);
    const base: TrialResult = { app: o.app.id, inputs: o.inputs, engine, trial: o.trial, status: "failed", counts: { aiCalls: 0, failedCalls: 0, pages: 0 } };
    const account = o.app.understanding?.credentials ?? o.app.credentials;
    let projectId: string | undefined;
    try {
        await o.host.start(o.seeded);
        await seedApp(o.host.url, account, o.app.understanding?.seed);
        const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        const project = await call("POST", "/api/projects", "Creating the project", { name: `Understanding: ${o.app.id} ${engine} ${o.trial} (${stamp})`.slice(0, 120) });
        projectId = String(project.id);
        // Baseline-U always has the URL and sign-in only; the candidate gets the configuration's inputs before it explores.
        if (engine === "candidate" && o.inputs === "full") {
            await call("PUT", `/api/projects/${projectId}/app-details`, "Setting the application address", { webUrl: o.host.url });
            await call("PUT", `/api/projects/${projectId}/agent-inputs`, "Setting the API description", { openApiUrl: `${o.host.url}/openapi.json` });
            const requirements = o.doc === "whole" ? [wholeDocumentRequirement(o.requirementsText ?? "")] : requirementsOf(o.requirementsText ?? "");
            if (o.doc === "records" && !requirements.length) throw new Error(`The requirements document of ${o.app.id} has no numbered requirement lines.`);
            await call("POST", `/api/projects/${projectId}/requirements/import`, "Importing the requirements", { requirements });
        }
        const exploration = {
            url: o.host.url,
            targets: ["web", "api"],
            plan: true,
            ...(o.level ? { level: o.level } : {}),
            ...(account ? { credentials: { username: account.username, password: account.password } } : {}),
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

        const readRules = async () => (await call("GET", `/api/projects/${projectId}/intel/rules`, "Reading the rules")).rules as Array<ScoredRule & { id: string; fingerprint: string }>;
        const versionCount = async () => ((await call("GET", `/api/projects/${projectId}/intel/models`, "Reading the model versions")).versions as unknown[]).length;
        // U7 is measured where a source can change: the candidate side of a full series (the requirements document).
        const u7 = engine === "candidate" && o.inputs === "full" && Boolean(o.requirementsText);

        // U7 decisions: a person's decision on every stored rule, confirmed and rejected in turn (by ref), before both reruns.
        let decided: ScoredRule[] = rules;
        if (u7) {
            const sorted = [...(await readRules())].sort((a, b) => a.ref.localeCompare(b.ref));
            for (const [i, r] of sorted.entries()) await call("PUT", `/api/projects/${projectId}/intel/rules/${encodeURIComponent(r.id)}/decision`, "Deciding about a rule", { status: i % 2 ? "rejected" : "confirmed", fingerprint: r.fingerprint });
            decided = await readRules();
        }

        // The no-change rerun: no new version and no AI call for sources that did not change.
        const versionsBefore = await versionCount();
        const same = await side.analyse(projectId);
        const versionsAfter = await versionCount();
        const rulesAfter = await readRules();
        const usageAfter = await aiCallsOf(client, projectId);

        // The one-change rerun: one requirement edited in a copy of the document (the original file is never written), that record updated.
        let oneChanged: { changed: string[]; reprocessed: string[] } | undefined;
        let changeDetail: Record<string, unknown> | undefined;
        let rulesChanged = rulesAfter;
        const edited: string[] = [];
        if (u7) {
            const copy = editedCopy(o.requirementsText!);
            if (!copy) throw new Error(`The requirements document of ${o.app.id} has no numbered requirement line to edit.`);
            fs.mkdirSync(path.join(o.out, "inputs"), { recursive: true });
            fs.writeFileSync(path.join(o.out, "inputs", `${o.app.id}-requirements-edited.md`), copy.text);
            const records = (t: string) => (o.doc === "whole" ? [wholeDocumentRequirement(t)] : requirementsOf(t).map((r) => ({ ...r, acceptanceCriteria: "" })));
            const was = new Map(records(o.requirementsText!).map((r) => [r.ref, r]));
            const stored = (await call("GET", `/api/projects/${projectId}/requirements`, "Reading the requirements")).requirements as Array<{ id: string; ref: string }>;
            for (const r of records(copy.text)) {
                const before = was.get(r.ref);
                if (before && before.title === r.title && before.description === r.description && before.acceptanceCriteria === r.acceptanceCriteria) continue;
                const row = stored.find((x) => x.ref === r.ref);
                if (!row) throw new Error(`The requirement ${r.ref} of ${o.app.id} was not imported.`);
                await call("PATCH", `/api/projects/${projectId}/requirements/${encodeURIComponent(row.id)}`, "Editing a requirement", { title: r.title, description: r.description, acceptanceCriteria: r.acceptanceCriteria });
                edited.push(r.ref);
            }
            const changed = await side.analyse(projectId);
            rulesChanged = await readRules();
            const usageChanged = await aiCallsOf(client, projectId);
            oneChanged = { changed: [`requirements ${REQUIREMENTS_REF}`], reprocessed: changed.processed };
            changeDetail = { edited, processed: changed.processed, failed: changed.failed, aiCalls: usageChanged.calls - usageAfter.calls, newVersion: changed.version, rules: changed.rules };
        }

        const model = version.model as AppModel;
        const judged = judgementFor(o.judgements, { app: o.app.id, engine, trial: o.trial, modelVersion: Number(version.version) });
        const notReachable = o.app.understanding?.notReachableScreens ?? [];
        const score = scoreUnderstanding({
            model,
            rules,
            key: o.key,
            keySha256: o.keySha256,
            catalogueWorkflows: o.catalogueWorkflows,
            ...(o.requirementsText ? { requirementsText: o.requirementsText } : {}),
            ...(judged.judgements ? { judgements: judged.judgements } : {}),
            ...(notReachable.length ? { notReachableScreens: notReachable.map((s) => s.id) } : {}),
            incremental: { before: decided, after: rulesChanged, changedSourceRefs: edited, noChange: { newVersion: versionsAfter > versionsBefore, aiCallsForUnchangedSources: usageAfter.calls - usage.calls }, ...(oneChanged ? { oneChanged } : {}) },
        });
        return {
            result: { ...base, status: "completed", score, counts: { aiCalls: usage.calls, failedCalls: usage.failedCalls, pages, byPurpose: usage.byPurpose } },
            detail: {
                projectId,
                jobId,
                modelVersion: version.version,
                sources: model.sources,
                discovery: discoveryOf(model),
                pagePaths: [...new Set(model.pages.map((p) => p.path))].sort(),
                account: account?.username ?? null,
                ...(engine === "candidate" && o.inputs === "full" ? { requirementsImport: o.doc } : {}),
                judgements: judged.judgements ? "applied" : (judged.note ?? "none recorded"),
                rules: rules.length,
                rerun: { versionsBefore, versionsAfter, aiCalls: usageAfter.calls - usage.calls },
                incremental: {
                    decided: decided.filter((r) => r.status !== "unverified").length,
                    noChange: { newVersion: versionsAfter > versionsBefore, aiCalls: usageAfter.calls - usage.calls, processed: same.processed, failed: same.failed },
                    ...(changeDetail ? { oneChanged: changeDetail } : {}),
                },
            },
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
    let judgements: Judgements[] = [];
    let paid: PaidPrices | undefined;
    let paidKey: string | undefined;
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
        if (args.judgements) judgements = loadJudgements(args.judgements, { inputs: args.inputs, keys: new Map([...keys].map(([app, k]) => [app, k.sha256])) });
        const est = understandingEstimate(args);
        log(`Configuration: ${args.inputs}; sides: ${args.engines.join(", ")}; ${args.repeat} analyses per side and app; apps: ${apps.map((a) => a.id).join(", ")}.`);
        log(`Estimate: at most ${est.total.toLocaleString("en-US")} AI calls (${args.engines.map((e) => `${e} up to ${est.perTrial[e]} per analysis`).join(", ")}).`);
        if (args.dailyCallCap !== undefined && est.total > args.dailyCallCap) log(`That is more than the daily cap of ${args.dailyCallCap}: the run stops at the cap and the series is reported incomplete.`);
        if (args.estimateOnly) return 0;
        if (!scripted) {
            // A measured run: approved keys, a daily cap, and either a free model (budget 0) or the paid table with a budget above 0.
            for (const [, k] of keys) requireApprovedKey(k.key, k.file);
            paid = args.prices ? paidPricesIn(args.prices) : undefined;
            if (paid) {
                if (!(args.budget !== undefined && args.budget > 0)) throw new Error(`A paid run (${path.basename(args.prices!)}) needs --approved-budget-usd above 0.`);
                if (!args.singleModel) throw new Error("A paid run uses one model only: give --single-model.");
                paidKey = paidKeyFrom(env);
                if (!paidKey) throw new Error(`A paid run reads its key from ${PAID_KEY_ENV}, which is not set.`);
            } else if (args.budget !== 0) throw new Error("Understanding runs use a free model only (--approved-budget-usd 0), or the paid price table eval/bench-prices-claude.json with a budget above 0.");
            if (args.dailyCallCap === undefined) throw new Error("Give --daily-call-cap: the free model's daily calls are shared with other runs.");
            if (!args.prices) throw new Error("Give --prices with a row for the model at 0 and 0.");
        }
    } catch (e) {
        log(`${e instanceof Error ? e.message : String(e)}\n\n${UNDERSTANDING_USAGE}`);
        return 2;
    }

    // The paid series: the key goes only into the guarded model client; the platforms, and this process while the run lasts, hold no key.
    const guard = paid ? new SpendGuard(args.budget!, paid) : undefined;
    const platformEnv = paid ? paidPlatformEnv(env) : env;
    const platformDeps = paid ? { ...deps, makeLlm: paidLlm(paidKey!, guard!, deps.anthropicFetch) } : deps;
    paidKey = undefined;
    const hidden: Record<string, string | undefined> = {};
    if (paid) {
        for (const k of Object.keys(process.env)) {
            if (/_API_KEY$|^LLM_/.test(k) || k === PAID_KEY_ENV) {
                hidden[k] = process.env[k];
                delete process.env[k];
            }
        }
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
                const p = await startPlatform(path.join(dataDir, engine), platformEnv, platformDeps);
                sides.push({ engine, client: p.client, stop: p.stop, analyse: analyserOf(p.platform) });
            }
            if (!scripted) {
                let free: (m: string) => boolean;
                if (paid) {
                    model = PAID_MODEL;
                    free = (m) => m === PAID_MODEL;
                } else {
                    const cfg = ok(await sides[0]!.client.call("GET", "/api/config"), "Reading the platform's settings");
                    if (!cfg?.llm?.configured) throw new Error("The benchmark needs an AI model. Set one up first (LLM_PROVIDER and its key in .env).");
                    model = String(cfg.llm.model ?? "unknown");
                    const prices = loadPrices(args.prices!);
                    free = (m: string) => prices.some((p) => p.model === m && p.inputPerMTok === 0 && p.outputPerMTok === 0);
                    if (!free(model)) throw new Error(`The model ${model} is not priced 0 in ${path.basename(args.prices!)}: understanding runs use a free model only.`);
                }
                // Every model the run would use, on every side: with --single-model the fast and planning models are switched off first.
                for (const side of sides) {
                    if (args.singleModel) {
                        ok(await side.client.call("PUT", "/api/llm/fast-model", { model: "" }), "Turning the fast model off");
                        ok(await side.client.call("PUT", "/api/llm/planning-model", { model: "" }), "Turning the planning model off");
                    }
                    const routing = ok(await side.client.call("GET", "/api/llm/fast-model"), "Reading which models are in use");
                    if (paid && routing?.mainModel !== PAID_MODEL) throw new Error(`The ${side.engine} platform's model is ${String(routing?.mainModel)}, not ${PAID_MODEL}.`);
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
                    if (guard?.stopped) {
                        stopped = guard.stopped;
                        break;
                    }
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
                        doc: args.doc,
                        judgements,
                        seeded: catalogue.defects.filter((d) => d.app === app.id).map((d) => d.id),
                        key: k.key,
                        keySha256: k.sha256,
                        catalogueWorkflows: [...new Set(catalogue.defects.filter((d) => d.app === app.id).map((d) => d.workflow))],
                        ...(args.inputs === "full" && k.requirementsText ? { requirementsText: k.requirementsText } : {}),
                        ...(args.level ? { level: args.level } : {}),
                        out: args.out,
                        deps,
                        log,
                    });
                    // A trial during which the budget stopped a call did not do all its work: it does not count.
                    if (guard?.stopped && result.status === "completed") Object.assign(result, { status: "failed", error: guard.stopped, score: undefined });
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

        const report = buildReport({ inputs: args.inputs, repeat: args.repeat, apps: apps.map((a) => a.id), trials, engines: args.engines, ...(args.inputs === "full" ? { doc: args.doc } : {}) });
        const head = [
            `Model: ${model}`,
            `Catalogue: ${catalogue.version} (${catalogue.sha256.slice(0, 12)})`,
            ...[...keys.values()].map((k) => `Answer key ${k.file}: version ${k.key.version}, ${k.key.review}, sha256 ${k.sha256.slice(0, 12)}`),
            "Baseline-U explores as an older runner does and analyses without AI, from the URL and sign-in only.",
            ...apps.flatMap((a) => [
                ...(a.understanding?.credentials ? [`${a.id}: the crawl signs in as ${a.understanding.credentials.username}, not the detection benchmark's account.`] : []),
                ...(a.understanding?.seed?.length ? [`${a.id}: seeded before the crawl: ${a.understanding.seed.map((s) => `${s.method} ${s.path}`).join(", ")}.`] : []),
                ...(a.understanding?.notReachableScreens ?? []).map((s) => `${a.id}: the screen ${s.id} is left out of U1: ${s.why}`),
            ]),
            `Recorded judgements: ${args.judgements ? `${judgements.length} trial(s) from ${path.basename(args.judgements)}` : "none"}.`,
            args.inputs === "full" && args.engines.includes("candidate")
                ? `U7 (candidate side): after the exploration's analysis every stored rule is decided through the API (confirmed and rejected in turn, by ref); the analysis then runs again with nothing changed, and once more after the last numbered requirement was edited in a copy of the document (appended "${EDIT_MARK.trim()}"; the copy is in inputs/). Both reruns run in this process on the side's own model client, so they can read with AI.`
                : "U7 here is the no-change rerun only (run in this process on the side's own model client); carrying rule decisions forward and re-processing one changed source are measured by a full series' candidate side.",
            ...(guard ? [`Spend: $${guard.spent.toFixed(4)} of the approved $${guard.budget.toFixed(2)} (${guard.calls} paid calls, ${guard.refused} refused before sending; effort low).`] : []),
            ...(stopped ? [stopped] : []),
            "",
        ];
        const md = renderReportMd(report).replace(/\n\n/, `\n\n${head.join("\n")}\n`);
        fs.mkdirSync(args.out, { recursive: true });
        const stem = path.join(args.out, `${startedAt.slice(0, 16).replace("T", "-").replace(":", "")}-understanding-${args.inputs}${report.complete ? "" : "-partial"}`);
        fs.writeFileSync(`${stem}.json`, JSON.stringify({ format: 1, startedAt, finishedAt: new Date().toISOString(), model, ...(guard ? { spend: { usd: guard.spent, budgetUsd: guard.budget, calls: guard.calls, refused: guard.refused } } : {}), options: { ...args, out: undefined, dataDir: undefined }, report, trials, details }, null, 2));
        fs.writeFileSync(`${stem}.md`, md);
        log(`Results: ${stem}.json`);
        return report.complete ? 0 : 3;
    } finally {
        for (const h of hosts) await h.stop?.().catch(() => undefined);
        for (const s of sides) await s.stop().catch(() => undefined);
        for (const [k, v] of Object.entries(hidden)) if (v !== undefined) process.env[k] = v;
    }
}

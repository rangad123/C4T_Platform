/**
 * `node scripts/eval.mjs bench --mode change --repo <dir> --out <dir>`: the PR bench (testing-engine Phase 6, spec §6.2). Deterministic and
 * free: no AI model is reachable (every call is refused and counted, G9), GitHub is the local fake (tests/fixtures/fake-github.ts) and the
 * repository is the local one examples/bench-repo/build.mjs makes. Nothing in the platform or the engine is told it is measured.
 *
 * One invocation is one step, so each step takes the browser lock on its own (scripts/eval.mjs holds it per command): the first sets up a
 * platform (its data folder in <out>/platform) with one project per app, the frozen suite (examples/bench-repo/suite.mjs) imported and
 * validated on main, and the repository connected; every later one takes the next pull request of the manifest:
 *   1. a signed `pull_request` opened delivery to the webhook; the platform reads the PR from the fake GitHub and saves its selection;
 *   2. the app started from the PR's head commit, fresh data before every run, and the focused set (the selection) and the full suite run
 *      through the run route, `--repeat` times, alternating which goes first;
 *   3. G6, through the platform's own paths: after a seed PR its failing tests' findings (verified by the platform, VERIFY_FINDINGS) are
 *      confirmed by a person and filed as issue #n; a claim PR ("Fixes #n", the bug still in) and then the fix PR ("Fixes #n") are deployed
 *      (`deployment_status` success) and checked by the regression service; after a fix the bug comes back (the seed's head runs again)
 *      and must reopen the finding.
 * Each step appends one line to <out>/steps.jsonl; after the last, score.ts writes <out>/pr-bench.json and .md. Exit codes: 0 a step ran,
 * 5 nothing is left (the report is written again), 2 bad options, 1 a step failed (it is not marked done; run it again).
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, type Config } from "../../../config.js";
import { unavailableLlmClient, type LlmClient } from "../../../engine/llm/provider.js";
import { KNOWN_BUG_FIXED } from "../../../engine/validation/runner.js";
import { REGRESSION_SUITE, STILL_REPRODUCES } from "../../../platform/findings/regression-service.js";
import { SuiteStore } from "../../../platform/suite-store.js";
import { ok, type PlatformClient } from "../../client.js";
import { BenchAppHost, benchApp } from "../apps.js";
import { startFakeGithub } from "../../../../tests/fixtures/fake-github.js";
import { renderChangeMd, scoreChange, type FixCheckRecord, type HistoryRecord, type PrStep, type RunRecord, type SetupRecord } from "./score.js";

export const CHANGE_USAGE = `Usage: node scripts/eval.mjs bench --mode change --repo <dir> --out <dir> [options]
  --repo <dir>       the repository examples/bench-repo/build.mjs made (with its prs.json)
  --out <dir>        the bench's folder: platform data, checkouts, steps.jsonl and the report
  --repeat <n>       runs of the focused set and of the full suite per pull request, alternating (default 5)
  --port-base <n>    bench-shop listens on it, bench-rbac on the next port (default 5491)
  --report           only score the steps done so far and write the report
  --all              every step left, one after another in this command (one browser lock for the series)
One step per invocation (the first is the setup); run it until it exits 5, or once with --all.`;

const OWNER = "acme";
const REPO = "bench";
const TOKEN = "github_pat_11BENCH0FAKE0PRBENCH0TOKEN0abcdef0123456789";
const SECRET = "whsec-bench-change-0123456789";
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
const FAILING = new Set(["failed", "finding"]);
const UNSETTLED = new Set(["detected", "candidate", "verification_pending"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ManifestPr {
    number: number;
    branch: string;
    title: string;
    base: string;
    head: string;
    kind: "seed" | "claim" | "fix" | "refactor" | "decoy" | "unmapped";
    app: "bench-shop" | "bench-rbac";
    seed?: string;
    issue?: number;
}
interface Manifest {
    format: 1;
    main: string;
    prs: ManifestPr[];
}
interface State {
    setup: SetupRecord;
    projects: Record<string, { id: string; tests: Record<string, string>; hookPath: string }>;
    done: number[];
    /** G7: what X2's quality history said per app once every PR had run. */
    history?: HistoryRecord;
}

export interface ChangeArgs {
    repo: string;
    out: string;
    repeat: number;
    portBase: number;
    report: boolean;
    all: boolean;
}

export function parseChangeArgs(argv: string[]): ChangeArgs | "help" {
    const a: Partial<ChangeArgs> = { repeat: 5, portBase: 5491, report: false, all: false };
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
            if (value() !== "change") throw new Error("--mode is change here");
        } else if (k === "--repo") a.repo = path.resolve(value());
        else if (k === "--out") a.out = path.resolve(value());
        else if (k === "--repeat") a.repeat = whole(1, 20);
        else if (k === "--port-base") a.portBase = whole(1024, 65000);
        else if (k === "--report") a.report = true;
        else if (k === "--all") a.all = true;
        else if (k === "--help" || k === "-h") return "help";
        else throw new Error(`Unknown option ${k}`);
    }
    if (!a.out) throw new Error("--out is required");
    if (!a.report && !a.repo) throw new Error("--repo is required");
    if (path.resolve(a.out) === path.resolve(REPO_ROOT, "data")) throw new Error("--out must not be the platform's own ./data folder");
    return a as ChangeArgs;
}

// ── the local repository ────────────────────────────────────────────────────
export const gitOf = (repo: string) => (...args: string[]) =>
    execFileSync("git", ["--git-dir", path.join(repo, ".git"), ...args], { env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const STATUS: Record<string, string> = { M: "modified", A: "added", D: "removed", R: "renamed" };

/** A pull request's files as GitHub's files API gives them: name, status, previous name and the unified patch (hunks only). */
export function prFiles(git: ReturnType<typeof gitOf>, pr: Pick<ManifestPr, "base" | "head">): Array<{ filename: string; status: string; patch?: string; previous_filename?: string }> {
    return git("diff", "--no-color", "-M", "--name-status", pr.base, pr.head)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [code, a, b] = line.split("\t") as [string, string, string | undefined];
            const filename = b ?? a;
            const diff = git("diff", "--no-color", "-M", "-U3", pr.base, pr.head, "--", ...(b ? [a, b] : [a]));
            const at = diff.indexOf("\n@@");
            return { filename, status: STATUS[code[0]!] ?? "modified", ...(at >= 0 ? { patch: diff.slice(at + 1).replace(/\n$/, "") } : {}), ...(b ? { previous_filename: a } : {}) };
        });
}

export const treeOf = (git: ReturnType<typeof gitOf>, sha: string): Record<string, string> =>
    Object.fromEntries(
        git("ls-tree", "-r", "--name-only", sha)
            .split("\n")
            .filter(Boolean)
            .map((p) => [p, git("show", `${sha}:${p}`)]),
    );

/** The head commit's files on disk (once per commit), for the app to run from. */
function checkout(git: ReturnType<typeof gitOf>, out: string, sha: string): string {
    const dir = path.join(out, "checkouts", sha);
    if (fs.existsSync(path.join(dir, ".complete"))) return dir;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [p, text] of Object.entries(treeOf(git, sha))) {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        fs.writeFileSync(path.join(dir, p), text);
    }
    fs.writeFileSync(path.join(dir, ".complete"), sha);
    return dir;
}

// ── the platform ────────────────────────────────────────────────────────────
interface Side {
    client: PlatformClient;
    platform: import("../../../platform/bootstrap.js").Platform;
    server: import("fastify").FastifyInstance;
    stop: () => Promise<void>;
}

/** No model is reachable: every call is refused, and counted (G9). */
export function countingNoModel(counter: { calls: number }): (config: Config) => LlmClient {
    return () => {
        const no = unavailableLlmClient("The PR bench runs without an AI model.");
        const count = <T>(f: () => T) => (counter.calls++, f());
        return { modelName: "none", get model() { return count(() => no.model); }, usage: no.usage, object: (a) => count(() => no.object(a)), text: (a) => count(() => no.text(a)), imageObject: (a) => count(() => no.imageObject!(a)) } as LlmClient;
    };
}

async function waitJob(client: PlatformClient, jobId: string, what: string, timeoutMs = 15 * 60_000): Promise<any> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const j = ok(await client.call("GET", `/api/test-generation/${jobId}`), `Reading ${what}`);
        if (DONE.includes(j.status)) return j;
        if (Date.now() > end) {
            await client.call("DELETE", `/api/test-generation/${jobId}`).catch(() => undefined);
            throw new Error(`${what} took too long and was stopped.`);
        }
        await sleep(250);
    }
}

/** A signed delivery to the project's webhook, as GitHub sends it. */
async function deliver(s: Side, hookPath: string, event: string, id: string, body: unknown): Promise<{ status: number; body: string }> {
    const raw = JSON.stringify(body);
    const sig = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
    const r = await s.server.inject({ method: "POST", url: hookPath, headers: { "content-type": "application/json", "x-hub-signature-256": sig, "x-github-event": event, "x-github-delivery": id }, payload: raw });
    return { status: r.statusCode, body: r.body };
}

const prPayload = (pr: ManifestPr) => ({
    action: "opened",
    number: pr.number,
    pull_request: { number: pr.number, title: pr.title, head: { sha: pr.head, ref: pr.branch, repo: { full_name: `${OWNER}/${REPO}` } }, base: { sha: pr.base, ref: "main", repo: { full_name: `${OWNER}/${REPO}` } } },
    repository: { full_name: `${OWNER}/${REPO}` },
});
const deploymentPayload = (sha: string) => ({ deployment: { sha, environment: "bench" }, deployment_status: { state: "success" }, repository: { full_name: `${OWNER}/${REPO}` } });

/** One run of these tests through the platform's run route on a freshly started app: wall time from the job, each test's state. */
async function runTests(s: Side, host: BenchAppHost, projectId: string, ids: string[], keyOf: Map<string, string>): Promise<Omit<RunRecord, "repeat" | "arm">> {
    if (!ids.length) return { tests: 0, ms: 0, failed: [], notRun: [], skipped: true };
    await host.start("none");
    const started = ok(await s.client.call("POST", `/api/projects/${projectId}/runs`, { testIds: ids }), "Starting a run");
    await waitJob(s.client, started.jobId, "a run");
    const job = s.platform.repo.getJob(started.jobId)!;
    const detail = ok(await s.client.call("GET", `/api/projects/${projectId}/runs/${started.jobId}`), "Reading a run");
    const states = new Map<string, string>(((detail.tests ?? []) as Array<{ id: string; state: string }>).map((t) => [t.id, t.state]));
    const reported = ids.filter((id) => FAILING.has(states.get(id) ?? "")).map((id) => keyOf.get(id)!);
    // What the app did: a test whose check failed against it. A test tracking an open bug runs as an expected failure, so the run reports
    // it passed while its check failed (and failed, "seems fixed", while every check passed); the app's outcome is its steps'.
    const failedHere = new Set(
        s.platform.db
            .all<{ test_case_id: string }>("SELECT DISTINCT e.test_case_id FROM test_executions e JOIN test_execution_steps st ON st.execution_id = e.id WHERE e.job_id = ? AND st.status = 'failed'", started.jobId)
            .map((r) => r.test_case_id),
    );
    const failed = ids.filter((id) => failedHere.has(id) || (FAILING.has(states.get(id) ?? "") && !s.platform.db.get("SELECT 1 AS x FROM test_executions WHERE job_id = ? AND test_case_id = ? AND error LIKE ?", started.jobId, id, `${KNOWN_BUG_FIXED}%`))).map((id) => keyOf.get(id)!);
    const notRun = ids.filter((id) => !["passed", ...FAILING].includes(states.get(id) ?? "")).map((id) => keyOf.get(id)!);
    const ms = job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : NaN;
    const quiet = await settled(s, projectId, reported.length > 0, started.jobId);
    return { tests: ids.length, ms, failed: failed.sort(), ...(reported.join() !== failed.join() ? { reported: reported.sort() } : {}), notRun: notRun.sort(), jobId: started.jobId, ...(quiet ? {} : { unsettled: true }) };
}

/**
 * Verification after a run happens in the background (VERIFY_FINDINGS): wait until this run's findings are written and none waits for
 * verification, so the next measured run does not share the machine with it.
 */
async function settled(s: Side, projectId: string, hadFailures: boolean, jobId?: string, timeoutMs = 180_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const fs_ = ok(await s.client.call("GET", `/api/projects/${projectId}/findings`), "Reading the findings").findings as Array<{ state: string; lastJobId?: string | null }>;
        const seen = !hadFailures || !jobId || s.platform.db.get("SELECT 1 AS x FROM candidate_findings WHERE project_id = ? AND last_job_id = ?", projectId, jobId);
        if (seen && !fs_.some((f) => UNSETTLED.has(f.state))) return true;
        // A failure that is the test's own step writes no finding (validation/test-fault.ts): the run is recorded as unsettled.
        if (Date.now() > end) return false;
        await sleep(500);
    }
}

async function waitSelection(s: Side, projectId: string, pr: ManifestPr): Promise<any> {
    for (let i = 0; i < 240; i++) {
        const r = s.platform.db.get<{ selected_json: string; reasons_json: string }>("SELECT selected_json, reasons_json FROM pr_selections WHERE project_id = ? AND pr = ? AND head_sha = ?", projectId, pr.number, pr.head);
        if (r) return { selected: JSON.parse(r.selected_json) as string[], reasons: JSON.parse(r.reasons_json) };
        await sleep(250);
    }
    throw new Error(`No selection was saved for pull request #${pr.number}.`);
}

/** The verification job a deployment queued (regression-service.ts claimFix), once it ended; undefined when none was queued. */
async function fixCheckJob(s: Side, projectId: string, after: string): Promise<string | undefined> {
    for (let i = 0; i < 40; i++) {
        const j = s.platform.db.get<{ id: string }>("SELECT id FROM generation_jobs WHERE project_id = ? AND created_at > ? AND options_json LIKE '%\"fixCheck\"%' ORDER BY created_at DESC LIMIT 1", projectId, after);
        if (j) {
            await waitJob(s.client, j.id, "a fix check");
            return j.id;
        }
        await sleep(250);
    }
    return undefined;
}

// ── steps ───────────────────────────────────────────────────────────────────
const readJsonl = (file: string): PrStep[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PrStep) : []);

export async function changeMain(argv: string[], deps: { log?: (s: string) => void } = {}): Promise<number> {
    const log = deps.log ?? ((s: string) => console.log(s));
    let args: ChangeArgs;
    try {
        const a = parseChangeArgs(argv);
        if (a === "help") {
            log(CHANGE_USAGE);
            return 0;
        }
        args = a;
        if (a.all) {
            // Each step still starts its own platform, as a separate command would; the series stops at the first failed step.
            const one = argv.filter((x) => x !== "--all");
            for (;;) {
                const rc = await changeMain(one, deps);
                if (rc !== 0) return rc === 5 ? 0 : rc;
            }
        }
    } catch (e) {
        log(e instanceof Error ? e.message : String(e));
        log(CHANGE_USAGE);
        return 2;
    }
    const stateFile = path.join(args.out, "state.json");
    const stepsFile = path.join(args.out, "steps.jsonl");
    const writeReport = () => {
        if (!fs.existsSync(stateFile)) throw new Error(`Nothing has run in ${args.out} yet.`);
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
        const steps = readJsonl(stepsFile);
        const report = scoreChange(state.setup, steps, state.history);
        fs.writeFileSync(path.join(args.out, "pr-bench.json"), JSON.stringify({ format: 1, writtenAt: new Date().toISOString(), setup: state.setup, report, steps }, null, 2));
        fs.writeFileSync(path.join(args.out, "pr-bench.md"), renderChangeMd(report));
        return report;
    };
    if (args.report) {
        writeReport();
        log(`Report written to ${path.join(args.out, "pr-bench.md")}`);
        return 0;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(args.repo, "prs.json"), "utf8")) as Manifest;
    const state: State | undefined = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : undefined;
    const next = state ? manifest.prs.find((p) => !state.done.includes(p.number)) : undefined;
    if (state && !next) {
        writeReport();
        log("Every pull request has run; the report is written.");
        return 5;
    }
    // No AI provider can be reached from here, whatever .env holds.
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const git = gitOf(args.repo);
    const port = (app: string) => args.portBase + (app === "bench-shop" ? 0 : 1);
    const counter = { calls: 0 };
    const head = next?.head ?? manifest.main;
    const gh = await startFakeGithub({
        token: TOKEN,
        owner: OWNER,
        repo: REPO,
        prs: Object.fromEntries(manifest.prs.map((p) => [p.number, { title: p.title, headSha: p.head, headRef: p.branch, files: prFiles(git, p), commits: [{ sha: p.head, message: p.title }] }])),
        source: treeOf(git, head),
    });
    process.env.CODE_HOST_GITHUB_API_URL = gh.url;
    fs.mkdirSync(args.out, { recursive: true });
    const { startPlatform } = await import("../cli.js");
    const started = await startPlatform(path.join(args.out, "platform"), { ...process.env, VERIFY_FINDINGS: "true", SCHEDULER_ENABLED: "false" }, { makeLlm: countingNoModel(counter), jobHooks: true });
    const s: Side = started;
    const hosts = new Map<string, BenchAppHost>();
    const hostFor = async (app: string, root: string) => {
        await hosts.get(app)?.stop();
        const h = new BenchAppHost(benchApp(app)!, port(app), root);
        hosts.set(app, h);
        return h;
    };
    try {
        if (!state) {
            const setup = await doSetup(s, args, git, manifest, gh.url, hostFor, port, counter);
            fs.writeFileSync(stateFile, JSON.stringify(setup, null, 2));
            log(`Set up: ${Object.entries(setup.projects).map(([app, p]) => `${app} ${Object.keys(p.tests).length} tests`).join(", ")}; G5 ${setup.setup.g5.pass ? "passed" : "failed"}; app models: ${JSON.stringify(setup.setup.appModel)}.`);
            return 0;
        }
        // The connection follows the fake GitHub to its port of this step (a new token is sent with it, as a person would).
        for (const p of Object.values(state.projects)) ok(await s.client.call("PUT", `/api/projects/${p.id}/code-host`, { owner: OWNER, repo: REPO, token: TOKEN, webhookSecret: SECRET, apiUrl: gh.url, feedback: true }), "Reconnecting the repository");
        const t0 = Date.now();
        const step = await doPr(s, args, git, manifest, state, next!, hostFor, counter);
        step.stepMs = Date.now() - t0;
        fs.appendFileSync(stepsFile, JSON.stringify(step) + "\n");
        state.done.push(next!.number);
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        log(`#${next!.number} ${next!.kind} ${next!.seed ?? next!.branch}: ${step.selection ? `${step.selection.selected.length}/${step.selection.total} selected` : "no selection"}${step.runs.length ? `, full failed ${step.runs.filter((r) => r.arm === "full").map((r) => r.failed.length).join("/")}` : ""}${step.fixCheck ? `, fix check: ${step.fixCheck.findings.map((f) => f.state).join(",")}` : ""}`);
        if (!manifest.prs.some((p) => !state.done.includes(p.number))) {
            // G7: the projects' quality history (Phase 6 X2), read through its route as the dashboard reads it.
            state.history = {};
            for (const [app, p] of Object.entries(state.projects)) {
                const h = ok(await s.client.call("GET", `/api/projects/${p.id}/quality`), "Reading the quality history").history;
                state.history[app] = { confirmed: h.discovery.confirmed, reopened: h.regressions.reopened, reopenedFindings: h.regressions.findings };
            }
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
            writeReport();
        }
        return 0;
    } catch (e) {
        log(`The step failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        return 1;
    } finally {
        for (const h of hosts.values()) await h.stop();
        await s.stop();
        await gh.close();
    }
}

async function doSetup(s: Side, args: ChangeArgs, git: ReturnType<typeof gitOf>, manifest: Manifest, ghUrl: string, hostFor: (app: string, root: string) => Promise<BenchAppHost>, port: (app: string) => number, counter: { calls: number }): Promise<State> {
    const { SUITE } = (await import(pathToFileURL(path.join(REPO_ROOT, "examples/bench-repo/suite.mjs")).href)) as { SUITE: Record<string, unknown[]> };
    const root = checkout(git, args.out, manifest.main);
    const projects: State["projects"] = {};
    const g5: SetupRecord["g5"] = { pass: true, notes: [] };
    const appModel: Record<string, string> = {};
    for (const app of ["bench-shop", "bench-rbac"] as const) {
        const host = await hostFor(app, root);
        await host.start("none");
        const id = String(ok(await s.client.call("POST", "/api/projects", { name: `PR bench ${app}` }), "Creating a project").id);
        const imported = ok(await s.client.call("POST", `/api/projects/${id}/specs`, { baseUrl: `http://127.0.0.1:${port(app)}`, validate: true, specs: SUITE[app] }), "Importing the suite");
        await waitJob(s.client, imported.jobId, "the suite's validation");
        const tests = s.platform.repo.listTests(id);
        const bad = tests.filter((t) => t.validationStatus !== "VALIDATED");
        if (bad.length) throw new Error(`${bad.length} test(s) of the frozen suite do not pass on main in ${app}: ${bad.map((t) => `${t.testKey} ${t.title} (${t.validationStatus})`).join("; ")}`);
        appModel[app] = await describeApp(s, id, `http://127.0.0.1:${port(app)}/openapi.json`);
        const conn = ok(await s.client.call("PUT", `/api/projects/${id}/code-host`, { owner: OWNER, repo: REPO, token: TOKEN, webhookSecret: SECRET, apiUrl: ghUrl, feedback: true }), "Connecting the repository");
        projects[app] = { id, tests: Object.fromEntries(tests.map((t) => [t.testKey, t.id])), hookPath: new URL(conn.webhookUrl, "http://x").pathname };
        // G5: the full suite starts from the selection route a PR view uses, with every runnable test.
        const full = await s.client.call("POST", `/api/projects/${id}/selection-run`, { selection: "full" });
        if (full.status !== 202 || full.body.testCount !== tests.length) {
            g5.pass = false;
            g5.notes.push(`${app}: the full run from the selection route answered ${full.status} with ${full.body?.testCount ?? "no"} tests of ${tests.length}.`);
        } else {
            const j = await waitJob(s.client, full.body.jobId, "the full run");
            const ran = s.platform.db.get<{ n: number }>("SELECT COUNT(DISTINCT test_case_id) AS n FROM test_executions WHERE job_id = ?", full.body.jobId)?.n ?? 0;
            if (j.status !== "COMPLETED" || Number(ran) !== tests.length) {
                g5.pass = false;
                g5.notes.push(`${app}: the full run ended ${j.status} with ${ran} of ${tests.length} tests run.`);
            } else g5.notes.push(`${app}: the full run from the selection route ran all ${tests.length} tests (${j.status}).`);
        }
        await settled(s, id, false);
        await host.stop();
    }
    return { setup: { main: manifest.main, appModel, suite: Object.fromEntries(Object.entries(projects).map(([a, p]) => [a, Object.keys(p.tests).length])), repeat: args.repeat, aiCalls: counter.calls, g5 }, projects, done: [] };
}

/**
 * The app's API description as a person gives it (the project's OpenAPI address, then an analysis; reading OpenAPI needs no AI): the
 * documented endpoint templates the selection matches captured path parts against. Returns what the model holds, or why there is none.
 */
async function describeApp(s: Side, projectId: string, openApiUrl: string): Promise<string> {
    const put = await s.client.call("PUT", `/api/projects/${projectId}/agent-inputs`, { openApiUrl });
    if (put.status >= 300) return `no OpenAPI address: ${JSON.stringify(put.body).slice(0, 200)}`;
    const started = await s.client.call("POST", `/api/projects/${projectId}/intel/analyse`);
    if (started.status !== 202) return `no analysis: ${JSON.stringify(started.body).slice(0, 200)}`;
    for (let i = 0; i < 240; i++) {
        const st = ok(await s.client.call("GET", `/api/projects/${projectId}/intel/sources`), "Reading the analysis");
        if (!st.running && st.last) break;
        await sleep(250);
    }
    const model = await s.client.call("GET", `/api/projects/${projectId}/intel/models/latest`);
    return model.status === 200 ? `${(model.body?.model?.endpoints ?? []).length} endpoints in app model version ${model.body?.version ?? "?"}` : `no app model (${model.status})`;
}

async function doPr(s: Side, args: ChangeArgs, git: ReturnType<typeof gitOf>, manifest: Manifest, state: State, pr: ManifestPr, hostFor: (app: string, root: string) => Promise<BenchAppHost>, counter: { calls: number }): Promise<PrStep> {
    const proj = state.projects[pr.app]!;
    const keyOf = new Map(Object.entries(proj.tests).map(([k, id]) => [id, k]));
    const total = Object.keys(proj.tests).length;
    const step: PrStep = { number: pr.number, kind: pr.kind, app: pr.app, ...(pr.seed ? { seed: pr.seed } : {}), title: pr.title, head: pr.head, runs: [], aiCalls: 0, stepMs: 0 };

    const before = counter.calls;
    const hook = await deliver(s, proj.hookPath, "pull_request", `pr-${pr.number}-${pr.head.slice(0, 12)}`, prPayload(pr));
    if (hook.status !== 202) throw new Error(`The webhook answered ${hook.status} for #${pr.number}: ${hook.body.slice(0, 300)}`);
    const sel = await waitSelection(s, proj.id, pr);
    step.aiCalls = counter.calls - before;
    const reasons = sel.reasons as { tests: Array<{ testId: string; reasons: string[]; why?: string; stale?: string }>; fullRunRecommended: boolean; fullRunReasons: string[]; unmapped: Array<{ path: string }>; endpoints: string[] };
    step.selection = {
        total,
        selected: sel.selected.map((id: string) => keyOf.get(id) ?? id).sort(),
        explained: reasons.tests.filter((t) => t.reasons.length > 0).map((t) => keyOf.get(t.testId) ?? t.testId).sort(),
        stale: reasons.tests.filter((t) => !t.reasons.length && t.stale).map((t) => keyOf.get(t.testId) ?? t.testId).sort(),
        fullRunRecommended: reasons.fullRunRecommended,
        fullRunReasons: reasons.fullRunReasons,
        unmapped: reasons.unmapped.map((u) => u.path),
        endpoints: reasons.endpoints,
    };
    const findings = async () => ok(await s.client.call("GET", `/api/projects/${proj.id}/findings`), "Reading the findings").findings as Array<{ id: string; state: string; testId?: string | null }>;
    const testOfFinding = (f: { testId?: string | null }) => (f.testId ? keyOf.get(f.testId) : undefined);

    const measure = async () => {
        const host = await hostFor(pr.app, checkout(git, args.out, pr.head));
        const focused = sel.selected as string[];
        const full = Object.values(proj.tests);
        for (let r = 1; r <= args.repeat; r++) {
            const order: Array<"focused" | "full"> = r % 2 === 1 ? ["focused", "full"] : ["full", "focused"];
            for (const arm of order) step.runs.push({ repeat: r, arm, ...(await runTests(s, host, proj.id, arm === "focused" ? focused : full, keyOf)) });
        }
    };
    // A fix PR is measured after its fix check (below): until then its tests' open issue links make them expect the failure.
    if (pr.kind !== "claim" && pr.kind !== "fix") await measure();

    if (pr.kind === "seed") {
        // A person confirms the platform's findings of the tests that failed, and files them as one issue.
        const issue = manifest.prs.find((p) => p.kind === "fix" && p.seed === pr.seed)?.issue;
        const failing = new Set(step.runs.filter((r) => r.arm === "full").flatMap((r) => r.failed));
        const confirmed: string[] = [];
        for (const f of await findings()) {
            const key = testOfFinding(f);
            if (!key || !failing.has(key) || !["reproduced", "unconfirmed", "confirmed"].includes(f.state)) continue;
            if (f.state !== "confirmed") ok(await s.client.call("POST", `/api/projects/${proj.id}/findings/${f.id}/transition`, { action: "confirm", reason: "Checked by the bench's person: the requirement says otherwise." }), "Confirming a finding");
            confirmed.push(f.id);
        }
        // shortcut: the issue link is written as the issue tracker integration writes it (the fake GitHub has no issue endpoint); upgrade when it gets one.
        for (const key of failing)
            s.platform.db.run("INSERT INTO issue_links (id, test_case_id, integration_id, provider, external_id, url, title, created_at) VALUES (?,?,?,?,?,?,?,?)", `bench-${pr.seed}-${key}`, proj.tests[key]!, null, "github", `#${issue}`, `https://github.example/${OWNER}/${REPO}/issues/${issue}`, `${pr.seed}`, new Date().toISOString());
        step.confirmed = { issue: issue ?? null, findings: confirmed, failingTests: [...failing].sort() };
    }

    /** The seed's head runs these fixed findings' tests again; which findings that run reopened. */
    const returnRun = async (fixed: FixCheckRecord["findings"]) => {
        const back = await hostFor(pr.app, checkout(git, args.out, seedStepOf()!.head));
        const run = await runTests(s, back, proj.id, fixed.map((f) => proj.tests[f.test!]!), keyOf);
        const reopened: string[] = [];
        const states: Record<string, string> = {};
        for (const f of fixed) {
            const detail = ok(await s.client.call("GET", `/api/projects/${proj.id}/findings/${f.id}`), "Reading a finding");
            if ((detail.history as Array<{ reason?: string | null }>).some((h) => (h.reason ?? "").startsWith("Reopened: the bug came back") && Boolean(run.jobId && h.reason!.includes(run.jobId.slice(0, 8))))) reopened.push(f.id);
            states[f.id] = detail.finding.state;
        }
        return { jobId: run.jobId ?? null, failed: run.failed, reopened, states };
    };
    const seedStepOf = () => readJsonl(path.join(args.out, "steps.jsonl")).find((x) => x.kind === "seed" && x.seed === pr.seed);
    if (pr.kind === "claim" || pr.kind === "fix") {
        const seedStep = readJsonl(path.join(args.out, "steps.jsonl")).find((x) => x.kind === "seed" && x.seed === pr.seed);
        const linked = seedStep?.confirmed?.findings ?? [];
        const check: FixCheckRecord = { issue: pr.issue ?? null, linked: linked.length, findings: [] };
        if (linked.length) {
            const host = await hostFor(pr.app, checkout(git, args.out, pr.head));
            await host.start("none");
            const after = new Date().toISOString();
            const d = await deliver(s, proj.hookPath, "deployment_status", `dep-${pr.number}-${pr.head.slice(0, 12)}`, deploymentPayload(pr.head));
            check.delivery = d.status;
            check.jobId = await fixCheckJob(s, proj.id, after);
            const suite = await new SuiteStore(s.platform.sql).findByName(proj.id, REGRESSION_SUITE);
            const inSuite = new Set(suite ? await new SuiteStore(s.platform.sql).testIds(suite.id) : []);
            for (const id of linked) {
                const detail = ok(await s.client.call("GET", `/api/projects/${proj.id}/findings/${id}`), "Reading a finding");
                const history = (detail.history as Array<{ reason?: string | null }>).map((h) => h.reason ?? "");
                const testId = detail.finding.testId as string | undefined;
                check.findings.push({ id, test: testId ? keyOf.get(testId) ?? testId : null, state: detail.finding.state, stillReproduces: history.some((h) => h.startsWith(STILL_REPRODUCES) && h.includes(`#${pr.number}`)), inRegressionSuite: Boolean(testId && inSuite.has(testId)) });
            }
        }
        if (pr.kind === "fix") {
            // Measured after the fix check: the Fixed findings' issue links are resolved by then (job-runner.ts knownBugsOf).
            await measure();
            const fixed = check.findings.filter((f) => f.state === "fixed");
            if (fixed.length && seedStep) {
                // The bug comes back: the run must reopen the fixed findings.
                const r = await returnRun(fixed);
                check.returned = { jobId: r.jobId, failed: r.failed };
                for (const f of fixed) {
                    f.reopened = r.reopened.includes(f.id);
                    f.stateAfterReturn = r.states[f.id];
                }
                // The return was a branch: a person confirms the returned bug and the fix is deployed again, so the next PRs start from
                // Fixed findings (else their resolved issue links would count again and mark the tests as expected failures).
                await settled(s, proj.id, false);
                for (const f of fixed) {
                    const st = ok(await s.client.call("GET", `/api/projects/${proj.id}/findings/${f.id}`), "Reading a finding").finding.state as string;
                    if (st === "reproduced" || st === "unconfirmed") ok(await s.client.call("POST", `/api/projects/${proj.id}/findings/${f.id}/transition`, { action: "confirm", reason: "The bug came back on a branch; checked by the bench's person." }), "Confirming a finding");
                }
                const host = await hostFor(pr.app, checkout(git, args.out, pr.head));
                await host.start("none");
                const after = new Date().toISOString();
                await deliver(s, proj.hookPath, "deployment_status", `dep2-${pr.number}-${pr.head.slice(0, 12)}`, deploymentPayload(pr.head));
                await fixCheckJob(s, proj.id, after);
                for (const f of fixed) f.fixedAgain = ok(await s.client.call("GET", `/api/projects/${proj.id}/findings/${f.id}`), "Reading a finding").finding.state === "fixed";
            }
        }
        step.fixCheck = check;
    }
    return step;
}

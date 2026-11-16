/**
 * The understanding benchmark command (`bench --mode understanding`, src/eval/bench/understanding/run.ts) end to end on both benchmark
 * apps, with a scripted model and small answer keys of the test's own: it proves the plumbing, not quality.
 *   - Baseline-U explores the way an older runner does and analyses without AI: no rule extraction call, no newer page fields, and the
 *     model says so; the candidate side reads pages with AI and keeps the newer page fields;
 *   - the report states its configuration (url or full) and never mixes them; every trial is confirmed; the estimate starts nothing;
 *   - a run with a real model refuses keys the owner has not approved, and any budget but 0;
 *   - the exploration API takes `understandingBaseline: true` only, and an exploration without it is unchanged.
 * Ports 9731–9732 (the apps). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/bench-understanding-run.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { ExtractionAnswerSchema } from "../src/engine/intel/extract/rules.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";
import { loadCatalogue } from "../src/eval/bench/catalogue.js";
import { benchMain } from "../src/eval/bench/cli.js";
import { understandingMain } from "../src/eval/bench/understanding/run.js";

const PORT = 9731;
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_MODEL_FAST", "CONCURRENCY"];
const saved: Record<string, string | undefined> = {};
let tmp = "";
let answersDir = "";
let inputsDir = "";
const lines: string[] = [];
const log = (s: string) => lines.push(s);

/** Every model call, by the side whose platform made it (its data folder ends in the side's name). */
const calls: Array<{ side: string; extraction: boolean }> = [];
const scriptedFor = (config: Config): LlmClient => {
    const side = path.basename(config.DATA_DIR);
    return {
        modelName: "scripted",
        model: undefined as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        text: async () => "",
        object: (async (args: { system: string; schema: unknown }) => {
            const extraction = args.schema === ExtractionAnswerSchema;
            calls.push({ side, extraction });
            if (extraction) return { rules: [], workflows: [], roles: [], transitions: [] };
            if (/analysing a web application/.test(args.system)) return { siteType: "ecommerce", purpose: "A small web application", features: [], pagePurposes: [], journeys: [], authenticationMechanisms: [] };
            return { scenarios: [] };
        }) as LlmClient["object"],
    };
};
const deps = () => ({ log, makeLlm: scriptedFor, answersDir, inputsDir, pollMs: 200, env: { ...process.env } });

/** A small answer key that parses (completeness is the unit test's business, not this one's). */
const smallKey = (app: string, catalogueVersion: string, review = "awaiting-owner") => ({
    app,
    version: "test",
    review,
    catalogueVersion,
    requirementsDocument: `${app}-requirements.md`,
    screens: [{ id: "sign-in", path: "/login", name: "Sign in", signIn: false }],
    workflows: [{ id: "sign-in", name: "Sign in", screens: ["sign-in"], endpoints: ["POST /api/login"] }],
    endpoints: [{ method: "POST", path: "/api/login", documented: true }],
    rules: [],
});

beforeAll(() => {
    for (const k of KEYS) {
        saved[k] = process.env[k];
        if (k === "CONCURRENCY") process.env[k] = "1";
        else delete process.env[k];
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-understanding-"));
    answersDir = path.join(tmp, "answers");
    inputsDir = path.join(tmp, "inputs");
    fs.mkdirSync(answersDir);
    fs.mkdirSync(inputsDir);
    const version = loadCatalogue().version;
    for (const app of ["bench-shop", "bench-rbac"]) {
        fs.writeFileSync(path.join(answersDir, `${app}.json`), JSON.stringify(smallKey(app, version)));
        fs.writeFileSync(path.join(inputsDir, `${app}-requirements.md`), "# Requirements\n\n- 1.1 A person signs in with an email address and a password.\n- 1.2 A wrong password is refused with a message.\n");
    }
});
afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

const readResult = (out: string) => {
    const f = fs.readdirSync(out).find((x) => /-understanding-(url|full)(-partial)?\.json$/.test(x))!;
    return { json: JSON.parse(fs.readFileSync(path.join(out, f), "utf8")), md: fs.readFileSync(path.join(out, f.replace(/\.json$/, ".md")), "utf8") };
};

describe("before anything starts", () => {
    it("--estimate-only through the bench command prints the configuration and the estimate and starts nothing", async () => {
        lines.length = 0;
        const out = path.join(tmp, "estimate");
        const code = await benchMain(["--mode", "understanding", "--inputs", "url", "--repeat", "5", "--estimate-only", "--out", out], deps());
        expect(code, lines.join("\n")).toBe(0);
        expect(lines.join("\n")).toMatch(/Configuration: url; sides: baseline, candidate; 5 analyses/);
        expect(lines.join("\n")).toMatch(/Estimate: at most [\d,]+ AI calls/);
        expect(fs.existsSync(out)).toBe(false);
    });
    it("a run with a real model refuses an answer key the owner has not approved", async () => {
        lines.length = 0;
        const { makeLlm: _m, ...real } = deps();
        expect(await understandingMain(["--mode", "understanding", "--apps", "bench-shop", "--approved-budget-usd", "0", "--daily-call-cap", "950", "--out", path.join(tmp, "real")], real)).toBe(2);
        expect(lines.join("\n")).toMatch(/bench-shop\.json is not approved by the owner/);
    });
    it("a run with a real model refuses any budget but 0", async () => {
        lines.length = 0;
        const approved = path.join(tmp, "answers-approved");
        fs.mkdirSync(approved, { recursive: true });
        fs.writeFileSync(path.join(approved, "bench-shop.json"), JSON.stringify(smallKey("bench-shop", loadCatalogue().version, "approved")));
        const { makeLlm: _m, ...real } = deps();
        expect(await understandingMain(["--mode", "understanding", "--apps", "bench-shop", "--approved-budget-usd", "5", "--daily-call-cap", "950", "--out", path.join(tmp, "real2")], { ...real, answersDir: approved })).toBe(2);
        expect(lines.join("\n")).toMatch(/free model only/);
    });
});

describe("free model only: every model the run would use", () => {
    // A dead local model address: no provider is ever reached. The app script does not exist, so a run that starts fails its trial (exit 3).
    const env = () => ({ ...process.env, LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_API_KEY: "dummy", LLM_MODEL: "free-model", LLM_MODEL_FAST: "paid-model" });
    const setup = (name: string) => {
        const dir = path.join(tmp, name);
        fs.mkdirSync(path.join(dir, "answers"), { recursive: true });
        fs.writeFileSync(path.join(dir, "answers", "bench-shop.json"), JSON.stringify(smallKey("bench-shop", loadCatalogue().version, "approved")));
        fs.writeFileSync(path.join(dir, "prices.json"), JSON.stringify([{ model: "free-model", inputPerMTok: 0, outputPerMTok: 0 }]));
        return dir;
    };
    const argv = (dir: string, extra: string[]) => ["--mode", "understanding", "--apps", "bench-shop", "--engine", "candidate", "--repeat", "1", "--approved-budget-usd", "0", "--daily-call-cap", "950", "--prices", path.join(dir, "prices.json"), "--yes", "--port-base", String(PORT), "--out", path.join(dir, "out"), "--data-dir", path.join(dir, "data"), ...extra];
    const realDeps = (dir: string) => ({ log, env: env(), answersDir: path.join(dir, "answers"), apps: [{ id: "bench-shop", script: "does-not-exist.js", workflows: [] }] });

    it("a fast model that is not the free one is refused before any trial", async () => {
        lines.length = 0;
        const dir = setup("fast-paid");
        expect(await understandingMain(argv(dir, []), realDeps(dir)), lines.join("\n")).toBe(2);
        expect(lines.join("\n")).toMatch(/paid-model/);
        expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
    }, 120_000);
    it("a planning model saved in the data folder is refused too", async () => {
        lines.length = 0;
        const dir = setup("planning-paid");
        const { startPlatform } = await import("../src/eval/bench/cli.js");
        const pre = await startPlatform(path.join(dir, "data", "candidate"), { ...env(), LLM_MODEL_FAST: "" }, {});
        await pre.client.call("PUT", "/api/llm/planning-model", { model: "paid-planner" });
        await pre.stop();
        expect(await understandingMain(argv(dir, []), { ...realDeps(dir), env: { ...env(), LLM_MODEL_FAST: "" } }), lines.join("\n")).toBe(2);
        expect(lines.join("\n")).toMatch(/paid-planner/);
    }, 120_000);
    it("--single-model switches the fast and planning models off, so the run may start", async () => {
        lines.length = 0;
        const dir = setup("single");
        const code = await understandingMain(argv(dir, ["--single-model"]), realDeps(dir));
        expect(lines.join("\n")).not.toMatch(/paid-model/);
        expect(code, lines.join("\n")).toBe(3); // started; the stand-in app script does not exist, so the trial failed
    }, 120_000);
});

describe("a url series, both sides, both apps", () => {
    it("Baseline-U makes no extraction call and keeps no newer page fields; the candidate does both; the report is url only", async () => {
        lines.length = 0;
        calls.length = 0;
        const out = path.join(tmp, "url");
        const code = await understandingMain(["--mode", "understanding", "--inputs", "url", "--repeat", "1", "--port-base", String(PORT), "--out", out, "--data-dir", path.join(tmp, "data-url"), "--yes"], deps());
        expect(code, lines.join("\n")).toBe(0);
        const { json, md } = readResult(out);
        expect(json.report.complete).toBe(true);
        expect(json.report.trialsRan).toBe(4);

        // No extraction call from the baseline platform; the candidate read pages with AI on both apps.
        expect(calls.filter((c) => c.side === "baseline" && c.extraction)).toEqual([]);
        expect(calls.filter((c) => c.side === "candidate" && c.extraction).length).toBeGreaterThanOrEqual(2);
        expect(calls.some((c) => c.side === "baseline")).toBe(true); // the baseline still explores with the model

        let candidateNewFields = 0;
        for (const app of ["bench-shop", "bench-rbac"]) {
            const base = json.details.find((d: { app: string; engine: string }) => d.app === app && d.engine === "baseline");
            const cand = json.details.find((d: { app: string; engine: string }) => d.app === app && d.engine === "candidate");
            expect(base.discovery, app).toMatchObject({ pagesWithNewFields: 0, olderRunnerNote: true });
            expect(base.discovery.pages, app).toBeGreaterThan(0);
            // The candidate's crawl marks its pages (no older-runner sentence); bench-rbac's pages happen to have no newer fields.
            expect(cand.discovery.olderRunnerNote, app).toBe(false);
            candidateNewFields += cand.discovery.pagesWithNewFields;
            // The no-change rerun made no version and no AI call.
            expect(cand.rerun.versionsAfter, app).toBe(cand.rerun.versionsBefore);
            expect(cand.rerun.aiCalls, app).toBe(0);
        }

        expect(candidateNewFields).toBeGreaterThan(0);

        expect(md).toMatch(/Input configuration: url/);
        expect(md).not.toMatch(/Input configuration: full/);
        expect(md).toMatch(/Trials: 1 per side, 4 of 4 ran/);
        expect(md).toMatch(/Baseline-U explores as an older runner does and analyses without AI/);
        expect(md).toMatch(/U7 here is the no-change rerun only/);
        expect(json.trials.every((t: { inputs: string }) => t.inputs === "url")).toBe(true);
    }, 900_000);
});

describe("a full series", () => {
    it("the candidate gets the OpenAPI document and the requirements; the report is full only", async () => {
        lines.length = 0;
        const out = path.join(tmp, "full");
        const code = await understandingMain(["--mode", "understanding", "--inputs", "full", "--engine", "candidate", "--apps", "bench-shop", "--repeat", "1", "--port-base", String(PORT), "--out", out, "--data-dir", path.join(tmp, "data-full"), "--yes"], deps());
        expect(code, lines.join("\n")).toBe(0);
        const { json, md } = readResult(out);
        const kinds = (json.details[0].sources as Array<{ kind: string; status: string }>).map((s) => `${s.kind}:${s.status}`);
        expect(kinds).toEqual(expect.arrayContaining(["openapi:processed", "requirements:processed"]));
        // The key's one documented endpoint is in the model as documented.
        expect(json.trials[0].score.endpoints).toMatchObject({ found: 1, total: 1 });
        expect(md).toMatch(/Input configuration: full/);
        expect(md).not.toMatch(/Input configuration: url/);
    }, 600_000);
});

describe("the exploration API's baseline flag", () => {
    const KEY = "understanding-run-key-7d2f";
    let dataDir = "";
    let platform: Platform;
    let app: Awaited<ReturnType<typeof buildServer>>;
    let stopBeat: (() => void) | undefined;
    const call = (method: string, url: string, payload?: unknown) =>
        app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
    beforeAll(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-understanding-api-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "understanding-run-secret-0123456789ab" }));
        stopBeat = startHeartbeat(platform.db); // explorations are queued; nothing here runs them
        app = await buildServer(platform);
    });
    afterAll(async () => {
        stopBeat?.();
        await app?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("takes true only; an exploration without it is stored without it", async () => {
        const id = (await call("POST", "/api/projects", { name: "Baseline flag" })).body.id as string;
        for (const bad of ["yes", false, 1]) expect((await call("POST", `/api/projects/${id}/test-generation`, { url: "https://shop.example/", plan: true, understandingBaseline: bad })).status).toBe(400);
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: "https://shop.example/", plan: true })).status).toBe(202);
        expect(platform.repo.listJobs(id)[0]!.options.understandingBaseline).toBeUndefined();
        platform.db.run("UPDATE generation_jobs SET status = 'FAILED' WHERE project_id = ?", id);
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: "https://shop.example/", plan: true, understandingBaseline: true })).status).toBe(202);
        expect(platform.repo.listJobs(id)[0]!.options.understandingBaseline).toBe(true);
    });
});

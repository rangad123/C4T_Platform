/**
 * The understanding benchmark command (`bench --mode understanding`, src/eval/bench/understanding/run.ts) end to end on both benchmark
 * apps, with a scripted model and small answer keys of the test's own: it proves the plumbing, not quality.
 *   - Baseline-U explores the way an older runner does and analyses without AI: no rule extraction call, no newer page fields, and the
 *     model says so; the candidate side reads pages with AI and keeps the newer page fields;
 *   - the report states its configuration (url or full) and never mixes them; every trial is confirmed; the estimate starts nothing;
 *   - a run with a real model refuses keys the owner has not approved, and any budget but 0;
 *   - the exploration API takes `understandingBaseline: true` only, and an exploration without it is unchanged.
 *   - each app's understanding settings apply: bench-rbac's crawl signs in as its admin and reaches People, bench-shop's cart is seeded so
 *     the crawl reaches the checkout; AI calls are counted by purpose; recorded judgements are loaded and applied to their trial; a full
 *     series can upload the requirements document whole, and the report says which variant it used.
 * Ports 9880–9881 (the apps). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/bench-understanding-run.test.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT, type Config } from "../src/config.js";
import { ExtractionAnswerSchema } from "../src/engine/intel/extract/rules.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";
import { loadCatalogue } from "../src/eval/bench/catalogue.js";
import { benchMain } from "../src/eval/bench/cli.js";
import { understandingMain } from "../src/eval/bench/understanding/run.js";
import { PAID_KEY_ENV } from "../src/eval/bench/understanding/paid.js";

const PORT = 9880;
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

describe("recorded judgements", () => {
    it("a judgements file recorded against another version of the answer key is refused before anything starts", async () => {
        lines.length = 0;
        const file = path.join(tmp, "judgements-other-key.json");
        fs.writeFileSync(file, JSON.stringify({ app: "bench-shop", inputs: "url", engine: "candidate", trial: 1, modelVersion: 1, answerKeySha256: "c".repeat(64), recordedBy: "lead", ownerReviewed: false, recordedAt: "2026-11-16T10:00:00.000Z" }));
        const out = path.join(tmp, "judgements-refused");
        expect(await understandingMain(["--mode", "understanding", "--apps", "bench-shop", "--judgements", file, "--out", out, "--yes"], deps())).toBe(2);
        expect(lines.join("\n")).toMatch(/another version of the answer key/);
        expect(fs.existsSync(out)).toBe(false);
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

describe("the paid series (a stand-in provider, no real call)", () => {
    const KEY_VALUE = "sk-ant-test-NEVER-SHOWN-7f3a91";
    const PRICES_FILE = path.join(REPO_ROOT, "eval/bench-prices-claude.json");
    const requests: Array<{ apiKey: string | null; effort: unknown }> = [];
    /** Answers like the provider: the analyser and the planner get minimal answers, everything else an empty one. */
    const provider = (outputTokens: number): typeof fetch => async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { system?: Array<{ text: string }> | string; output_config?: { effort?: unknown }; max_tokens?: number };
        requests.push({ apiKey: new Headers(init?.headers as HeadersInit).get("x-api-key"), effort: body.output_config?.effort });
        const system = Array.isArray(body.system) ? body.system.map((s) => s.text).join("\n") : String(body.system ?? "");
        const answer = /analysing a web application/.test(system)
            ? { siteType: "ecommerce", purpose: "A small web application", features: [], pagePurposes: [], journeys: [], authenticationMechanisms: [] }
            : /list what they state about its intended behaviour/.test(system)
              ? { rules: [], workflows: [], roles: [], transitions: [] }
              : { scenarios: [] };
        return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: Math.min(outputTokens, body.max_tokens ?? outputTokens) } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const approvedDir = () => {
        const dir = path.join(tmp, `paid-answers-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "bench-shop.json"), JSON.stringify(smallKey("bench-shop", loadCatalogue().version, "approved")));
        return dir;
    };
    const argv = (name: string, extra: string[]) => ["--mode", "understanding", "--apps", "bench-shop", "--engine", "candidate", "--repeat", "1", "--daily-call-cap", "950", "--port-base", String(PORT), "--out", path.join(tmp, name, "out"), "--data-dir", path.join(tmp, name, "data"), "--yes", ...extra];
    const paidDeps = (outputTokens = 200) => ({ log, env: { ...process.env, [PAID_KEY_ENV]: KEY_VALUE }, answersDir: approvedDir(), anthropicFetch: provider(outputTokens), pollMs: 200 });
    /** Every byte the runs wrote (results, platform data) and said. */
    const everything = (name: string) => {
        const out: string[] = [lines.join("\n")];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) walk(f);
                else out.push(fs.readFileSync(f).toString("latin1"));
            }
        };
        walk(path.join(tmp, name));
        return out.join("\n");
    };

    it("is refused without the paid price table, with a budget of 0, without --single-model, or without the key", async () => {
        const cases: Array<[string[], object, RegExp]> = [
            [["--approved-budget-usd", "5", "--single-model"], {}, /free model only/],
            [["--approved-budget-usd", "0", "--prices", PRICES_FILE, "--single-model"], {}, /needs --approved-budget-usd above 0/],
            [["--approved-budget-usd", "1", "--prices", PRICES_FILE], {}, /give --single-model/],
            [["--approved-budget-usd", "1", "--prices", PRICES_FILE, "--single-model"], { env: { ...process.env } }, /BENCH_ANTHROPIC_API_KEY, which is not set/],
        ];
        for (const [extra, over, why] of cases) {
            lines.length = 0;
            expect(await understandingMain(argv("paid-refused", extra), { ...paidDeps(), ...over }), lines.join("\n")).toBe(2);
            expect(lines.join("\n")).toMatch(why);
        }
        expect(fs.existsSync(path.join(tmp, "paid-refused", "out"))).toBe(false);
    });

    it("sends every call at low effort with the key, prints the spend, and the key appears nowhere", async () => {
        lines.length = 0;
        requests.length = 0;
        const code = await understandingMain(argv("paid-run", ["--approved-budget-usd", "1", "--prices", PRICES_FILE, "--single-model"]), paidDeps());
        expect(code, lines.join("\n")).toBe(0);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((r) => r.apiKey === KEY_VALUE && r.effort === "low")).toBe(true);
        const { json, md } = readResult(path.join(tmp, "paid-run", "out"));
        // Each answer: 1,000 in × $0.10 + 200 out × $0.50, per million = $0.0002.
        expect(json.spend.calls).toBe(requests.length);
        expect(json.spend.usd).toBeCloseTo(requests.length * 0.0002, 10);
        expect(md).toMatch(/Model: claude-haiku-5-5/);
        expect(md).toMatch(/Spend: \$0\.\d{4} of the approved \$1\.00/);
        expect(everything("paid-run")).not.toContain(KEY_VALUE);
        expect(JSON.stringify(process.env)).not.toContain(KEY_VALUE);
    }, 600_000);

    it("stops before a call that could pass the budget: the series is incomplete and the spend stays under it", async () => {
        lines.length = 0;
        requests.length = 0;
        // Each answer uses its whole max_tokens (up to 20,000 out, about $0.01 each); a request's worst case is its max_tokens of output,
        // so a budget of $0.01 runs out within the first trial (the two trials above needed about $0.03).
        const code = await understandingMain(argv("paid-stop", ["--approved-budget-usd", "0.01", "--prices", PRICES_FILE, "--single-model", "--repeat", "2"]), paidDeps(20_000));
        expect(code, lines.join("\n")).toBe(3);
        const { json, md } = readResult(path.join(tmp, "paid-stop", "out"));
        expect(json.spend.refused).toBeGreaterThanOrEqual(1);
        expect(json.spend.usd).toBeLessThanOrEqual(0.01);
        expect(json.report.complete).toBe(false);
        expect(json.trials.filter((t: { status: string }) => t.status === "completed")).toEqual([]);
        expect(md).toMatch(/Stopped before a call that could take the spend past the approved \$0\.01/);
        expect(everything("paid-stop")).not.toContain(KEY_VALUE);
    }, 600_000);
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

        // The understanding settings: rbac's crawl is the admin's and reaches People; shop's seeded cart line opens the checkout.
        for (const engine of ["baseline", "candidate"]) {
            const rbac = json.details.find((d: { app: string; engine: string }) => d.app === "bench-rbac" && d.engine === engine);
            const shop = json.details.find((d: { app: string; engine: string }) => d.app === "bench-shop" && d.engine === engine);
            expect(rbac.account, engine).toBe("ada@example.test");
            expect(rbac.pagePaths, engine).toContain("/admin/users");
            expect(shop.account, engine).toBe("alice@example.test");
            expect(shop.pagePaths, engine).toContain("/checkout");
        }
        expect(md).toMatch(/bench-shop: the screen checkout-review is left out of U1/);
        // AI calls by purpose, adding up to the total.
        for (const t of json.trials as Array<{ counts: { aiCalls: number; byPurpose: { analysis: number; planning: number; other: number } } }>) {
            const p = t.counts.byPurpose;
            expect(p.analysis + p.planning + p.other).toBe(t.counts.aiCalls);
        }
        expect(md).toMatch(/\| U8-analysis \| AI calls per analysis: reading the application \|/);

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
        expect(md).toMatch(/Requirements document: imported one record per numbered requirement/);
        expect(md).not.toMatch(/Input configuration: url/);
    }, 600_000);
    it("--doc whole uploads the document as one requirement, and recorded judgements are applied to their trial", async () => {
        lines.length = 0;
        const out = path.join(tmp, "full-whole");
        const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(answersDir, "bench-shop.json"))).digest("hex");
        const file = path.join(tmp, "judgements-whole.json");
        fs.writeFileSync(file, JSON.stringify([{ app: "bench-shop", inputs: "full", engine: "candidate", trial: 1, modelVersion: 1, answerKeySha256: sha, recordedBy: "lead", ownerReviewed: false, recordedAt: "2026-11-16T10:00:00.000Z" }]));
        const code = await understandingMain(["--mode", "understanding", "--inputs", "full", "--doc", "whole", "--judgements", file, "--engine", "candidate", "--apps", "bench-shop", "--repeat", "1", "--port-base", String(PORT), "--out", out, "--data-dir", path.join(tmp, "data-full-whole"), "--yes"], deps());
        expect(code, lines.join("\n")).toBe(0);
        const { json, md } = readResult(out);
        const d = json.details[0];
        expect(d.requirementsImport).toBe("whole");
        expect(d.judgements).toBe("applied");
        expect((d.sources as Array<{ kind: string; status: string }>).map((s) => `${s.kind}:${s.status}`)).toContain("requirements:processed");
        expect(json.report.doc).toBe("whole");
        expect(md).toMatch(/Requirements document: uploaded whole, as one document/);
        expect(md).toMatch(/Recorded judgements: 1 trial\(s\) from judgements-whole\.json/);
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

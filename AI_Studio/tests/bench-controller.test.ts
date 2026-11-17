/**
 * The benchmark command end to end (src/eval/bench: cli.ts, controller.ts), on a stand-in app with three known behaviours
 * (tests/fixtures/bench-standin.mjs) and a scripted model: it proves the plumbing, the attribution by replay and the numbers, not quality.
 *   - the platform the command starts explores the app with its behaviours on, in a real Chromium; the page health checks report findings;
 *   - each finding is replayed with the behaviours on, all off and each one alone: the failing item list is confirmed and attributed to SI-1,
 *     the broken link (there with everything off too) is a false positive, the wrong total (nothing checks it) is missed;
 *   - the daily call cap stops the run and saves its state, --resume finishes it on the same platform data, and only then is the
 *     baseline written (once; a second baseline is refused); that run replays in isolation with a 180-minute job limit, which the resume
 *     cannot change;
 *   - a default run's config has neither the job limit nor isolated replays (as before they existed);
 *   - a run with a real model refuses to start without a price and a budget; a free model is approved with a budget of 0;
 *   - the defect ids and the catalogue never reach the platform: no project, test or exploration request carries them.
 * Ports 9471 (the stand-in app). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/bench-controller.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { BenchApp } from "../src/eval/bench/apps.js";
import { benchMain, onlyOptions, withoutOptions } from "../src/eval/bench/cli.js";
import { verifyBaseline } from "../src/eval/bench/record.js";
import type { EvalRun } from "../src/eval/run.js";

const PORT = 9471;
const APP: BenchApp = {
    id: "bench-standin",
    script: "tests/fixtures/bench-standin.mjs",
    workflows: [
        { name: "Home", paths: ["/"] },
        { name: "Shop", paths: ["/shop", "/api/items"] },
        { name: "About", paths: ["/about"] },
        { name: "Checkout", paths: ["/checkout"] },
    ],
};
const CATALOGUE = {
    version: "test-1",
    defects: [
        { id: "SI-1", app: "bench-standin", workflow: "Shop", category: "api-contract", severity: "high", expected: "The item list loads", actual: "HTTP 500" },
        { id: "SI-2", app: "bench-standin", workflow: "Home", category: "calculation", severity: "medium", expected: "Total $30.00", actual: "Total $31.00" },
    ],
};
// Only page health: the other check families would add findings about the stand-in itself (headers, accessibility) that this test is not about.
const ONLY_HEALTH = { targets: ["web"], accessibility: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false };

/** Understanding and planning only: no journey to author, so the findings come from the deterministic page health checks. */
const llmCalls: string[] = [];
let delayMs = 0;
const scripted: LlmClient = {
    modelName: "scripted",
    model: undefined as never,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async (args: { system: string; prompt: string }) => {
        llmCalls.push(`${args.system}\n${args.prompt}`);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (/analysing a web application/.test(args.system)) return { siteType: "ecommerce", purpose: "A small shop", features: ["Shop"], pagePurposes: [], journeys: [], authenticationMechanisms: [] };
        return { scenarios: [] };
    }) as LlmClient["object"],
};

let tmp: string;
let catalogueFile: string;
const lines: string[] = [];
const log = (s: string) => lines.push(s);
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_MODEL_FAST", "CONCURRENCY"];
const saved: Record<string, string | undefined> = {};
const deps = () => ({ log, makeLlm: () => scripted, apps: [APP], catalogueFile, pollMs: 150, exploration: ONLY_HEALTH, env: { ...process.env } });

beforeAll(() => {
    for (const k of KEYS) {
        saved[k] = process.env[k];
        if (k === "CONCURRENCY") process.env[k] = "1";
        else delete process.env[k];
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-bench-"));
    catalogueFile = path.join(tmp, "catalogue.json");
    fs.writeFileSync(catalogueFile, JSON.stringify(CATALOGUE));
});

afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    // The baseline files are read-only.
    const walk = (d: string) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) walk(p);
            else fs.chmodSync(p, 0o644);
        }
    };
    if (tmp && fs.existsSync(tmp)) {
        walk(tmp);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("the benchmark command on a stand-in app", () => {
    it("measures, attributes by replay and records everything", async () => {
        const out = path.join(tmp, "run1");
        const code = await benchMain(["--apps", "bench-standin", "--port-base", String(PORT), "--out", out, "--data-dir", path.join(tmp, "data1"), "--yes"], deps());
        expect(code, lines.join("\n")).toBe(0);
        const file = fs.readdirSync(out).find((f) => /benchmark-discovery\.json$/.test(f))!;
        const run = readJson(path.join(out, file)) as EvalRun;
        const b = run.benchmark!;
        const app = b.apps[0]!;
        expect(app.status, app.reason).toBe("done");
        expect(app.seededDefects).toEqual(["SI-1", "SI-2"]);
        // The failing item list: confirmed and attributed to SI-1 alone.
        const shop = app.findings.find((f) => f.title.includes("(/shop)"))!;
        expect(shop, JSON.stringify(app.findings, null, 1)).toBeTruthy();
        expect(shop).toMatchObject({ source: "check", category: "confirmed", defects: ["SI-1"] });
        expect(shop.replay).toMatchObject({ seeded: expect.stringMatching(/failed|finding/), clean: "passed", single: { "SI-1": expect.stringMatching(/failed|finding/), "SI-2": "passed" } });
        expect(shop.firstSeenAt).not.toBeNull();
        // The broken link is there with everything off as well: a false positive.
        const about = app.findings.find((f) => f.title.includes("(/about)"))!;
        expect(about.category).toBe("false_positive");
        expect(app.defects).toEqual([
            expect.objectContaining({ id: "SI-1", detected: true, findings: [shop.testKey] }),
            expect.objectContaining({ id: "SI-2", detected: false }),
        ]);
        const m = b.metrics;
        expect(m).toMatchObject({ seeded: 2, detected: 1, missed: 1, detectionRate: 0.5 });
        expect(m.falsePositives).toBeGreaterThanOrEqual(1);
        expect(m.precision).toBe(m.truePositives / m.findings);
        expect(m.reproductionRate).toBe(m.reproduced / m.findings);
        expect(m.detectionTimeMs).not.toBeNull();
        expect(m.workflows).toBe(4);
        expect(m.workflowsCovered).toBeGreaterThanOrEqual(3);
        expect(m.workflowsCovered).toBeLessThan(4);
        expect(m.aiCalls).toBeGreaterThanOrEqual(2);
        // Recorded: engine, prompts, model, catalogue, app version, options.
        expect(b.config).toMatchObject({ model: { provider: "scripted", model: "scripted" }, catalogueVersion: expect.stringMatching(/^test-1 \([0-9a-f]{12}\)$/), apps: [{ id: "bench-standin", version: expect.stringMatching(/^[0-9a-f]{16}$/) }], approvedBudget: null, resumes: 0 });
        expect(b.config.prompts.length).toBeGreaterThan(3);
        expect(b.config.options).not.toHaveProperty("jobTimeoutMin");
        expect(b.config.options).not.toHaveProperty("isolatedReplays");
        expect(run.overall.benchmark).toMatchObject({ mode: "discovery", seeded: 2, detected: 1 });
        expect(fs.readFileSync(path.join(out, file.replace(/\.json$/, ".md")), "utf8")).toContain("| SI-1 |");
        expect(fs.readFileSync(path.join(out, file.replace(/\.json$/, ".md")), "utf8")).toContain("Job time limit 45 minutes; replays one job per stage");
        // Nothing of the catalogue reached the platform: the model never saw a defect id or description.
        for (const c of llmCalls) for (const s of ["SI-1", "SI-2", "HTTP 500", "Total $31.00", "test-1"]) expect(c).not.toContain(s);
        // No state is left behind by a finished run.
        expect(fs.existsSync(path.join(out, "bench-state.json"))).toBe(false);
    }, 600_000);

    it("stops at the daily call cap, keeps its state, resumes on the same data and only then writes the baseline (once)", async () => {
        const out = path.join(tmp, "run2");
        delayMs = 1500;
        const stopped = await benchMain(["--apps", "bench-standin", "--port-base", String(PORT), "--out", out, "--data-dir", path.join(tmp, "data2"), "--baseline", "--daily-call-cap", "1", "--isolated-replays", "--job-timeout-min", "180", "--yes"], deps());
        delayMs = 0;
        expect(stopped, lines.join("\n")).toBe(4);
        const state = readJson(path.join(out, "bench-state.json"));
        expect(state.apps[0].status).toBe("stopped");
        expect(state.apps[0].reason).toMatch(/daily call cap/);
        expect(fs.existsSync(path.join(out, "baseline.json"))).toBe(false);
        expect(fs.readdirSync(out).some((f) => /-partial\.json$/.test(f))).toBe(true);

        const resumed = await benchMain(["--resume", "--out", out, "--daily-call-cap", "1000", "--job-timeout-min", "30", "--yes"], deps());
        expect(resumed, lines.join("\n")).toBe(0);
        const base = readJson(path.join(out, "baseline.json")) as EvalRun;
        expect(base.benchmark!.baseline).toBe(true);
        expect(base.benchmark!.config.resumes).toBe(1);
        expect(base.benchmark!.config.dailyCallCap).toBe(1000);
        expect(base.benchmark!.apps[0]!.status).toBe("done");
        expect(base.benchmark!.metrics.detected).toBe(1);
        // Replayed one finding per job (same attribution as the batched run above), with the first attempt's limits.
        expect(base.benchmark!.config.options).toMatchObject({ jobTimeoutMin: 180, isolatedReplays: true });
        expect(fs.readFileSync(path.join(out, "baseline.md"), "utf8")).toMatch(/Job time limit 180 minutes; replays isolated/);
        expect(verifyBaseline(out)).toBe(true);
        expect(fs.existsSync(path.join(out, "bench-state.json"))).toBe(false);
        // Immutable: a second baseline in the same folder is refused before anything runs.
        expect(await benchMain(["--apps", "bench-standin", "--out", out, "--baseline", "--yes"], deps())).toBe(2);
        expect(lines.at(-1)).toMatch(/never overwritten/);
    }, 600_000);
});

describe("the cost guard", () => {
    // A real (configured) model that is never called: every case below stops before any AI work.
    const realEnv = () => ({ ...process.env, LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_API_KEY: "test-not-a-key", LLM_MODEL: "vendor/some-model:free" });
    const realDeps = () => ({ log, apps: [APP], catalogueFile, pollMs: 150, env: realEnv() });

    it("refuses a real model without a price, or without an approved budget", async () => {
        const prices = path.join(tmp, "prices.json");
        fs.writeFileSync(prices, JSON.stringify([{ model: "vendor/some-model:free", inputPerMTok: 0, outputPerMTok: 0, note: "free (OpenRouter :free variant)" }]));
        lines.length = 0;
        expect(await benchMain(["--apps", "bench-standin", "--out", path.join(tmp, "g1"), "--data-dir", path.join(tmp, "dg1"), "--yes"], realDeps())).toBe(2);
        expect(lines.join("\n")).toMatch(/needs a price for the model vendor\/some-model:free/);
        lines.length = 0;
        expect(await benchMain(["--apps", "bench-standin", "--prices", prices, "--out", path.join(tmp, "g2"), "--data-dir", path.join(tmp, "dg2"), "--yes"], realDeps())).toBe(2);
        expect(lines.join("\n")).toMatch(/Approve a budget first/);
        // A free model: the estimate, its price note and a budget of 0 are accepted (estimate only: nothing runs).
        lines.length = 0;
        expect(await benchMain(["--apps", "bench-standin", "--prices", prices, "--approved-budget-usd", "0", "--max", "--daily-call-cap", "50", "--estimate-only", "--out", path.join(tmp, "g3"), "--data-dir", path.join(tmp, "dg3")], realDeps())).toBe(0);
        const said = lines.join("\n");
        expect(said).toMatch(/Estimated AI use/);
        expect(said).toMatch(/Price: free \(OpenRouter :free variant\)/);
        expect(said).toMatch(/more than the daily cap of 50/);
    }, 120_000);

    it("a price above 0 with a budget of 0 is refused", async () => {
        const prices = path.join(tmp, "prices-paid.json");
        fs.writeFileSync(prices, JSON.stringify([{ model: "vendor/some-model:free", inputPerMTok: 2, outputPerMTok: 10 }]));
        lines.length = 0;
        expect(await benchMain(["--apps", "bench-standin", "--prices", prices, "--approved-budget-usd", "0", "--out", path.join(tmp, "g4"), "--data-dir", path.join(tmp, "dg4"), "--yes"], realDeps())).toBe(2);
        expect(lines.join("\n")).toMatch(/not free in the price table/);
    }, 120_000);
});

describe("resume keeps the first attempt's options", () => {
    it("only --yes, the budget, the daily cap and --out may change", () => {
        const first = ["--apps", "a", "--max", "--approved-budget-usd", "0", "--daily-call-cap", "5", "--out", "x", "--yes"];
        expect(withoutOptions(first, new Set(["--yes", "--approved-budget-usd", "--daily-call-cap", "--resume", "--out"]))).toEqual(["--apps", "a", "--max"]);
        expect(onlyOptions(["--resume", "--daily-call-cap", "9", "--yes", "--apps", "b"], new Set(["--yes", "--daily-call-cap", "--resume"]))).toEqual(["--resume", "--daily-call-cap", "9", "--yes"]);
    });
});

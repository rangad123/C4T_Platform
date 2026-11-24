/**
 * eng-fix3-verify: the three Phase 5 gaps of VERIFY-P5-P7 §4 (rows 2, 10, 11). Real platform (SQLite, object store), scripted executor
 * and scripted model doubles, a local fake GitHub; no browser.
 *   1. The AI explanation (explain.ts) is called by verification for a finding whose class the rules left open: it may pick only among
 *      the verdict's candidates (also the expectation check's open pair, eng-fix3 6a7b22b1), its class is stored with the confidence
 *      capped at medium, and its explanation is kept in the finding's history. A decided class asks no AI.
 *   2. Root cause on the product routes reads the project's connected GitHub repository; with none connected the reason says so.
 *   3. The evidence package keeps the masked response bodies (at most 8 KB each) of the failing step's requests, from the attempt's trace.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { findingFingerprint } from "../src/engine/explore/finding.js";
import { classify } from "../src/engine/findings/classify.js";
import { explainGroup } from "../src/engine/findings/explain.js";
import { FindingViewSchema } from "../src/engine/findings/view.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { harvestExecutionFindings, verifyDepsOf, verifyFindings, type EvidencePackage, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { startFakeGithub } from "./fixtures/fake-github.js";

const KEY = "eng-fix3-verify-key-77a1";
const GH_TOKEN = "github_pat_11FAKE0FIX3VERIFY0TOKEN0abcdef0123456789";
const PW = "plain-lake-canary-pw";
const HEAD = "2222222222222222222222222222222222222222";
const APP_JS = [
    'const express = require("express");',
    "const app = express();",
    "function total(lines) {",
    "    return lines.reduce((s, l) => s + l.price, 0) * 2;",
    "}",
    'app.get("/api/orders/:id", async (req, res) => {',
    "    const order = await db.orders.findOne({ id: req.params.id });",
    "    res.json({ ...order, total: total(order.lines) });",
    "});",
    "module.exports = app;",
].join("\n");

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let gh: Awaited<ReturnType<typeof startFakeGithub>>;
let dir = "";
const envBefore = process.env.CODE_HOST_GITHUB_API_URL;
beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    gh = await startFakeGithub({ token: GH_TOKEN, branches: { main: { sha: HEAD } }, source: { "src/app.js": APP_JS, "README.md": "shop\n" } });
    process.env.CODE_HOST_GITHUB_API_URL = gh.url;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-fix3v-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, API_KEY: KEY, SECRET_KEY: "eng-fix3-verify-secret-key-0123456789abc", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.ready();
});
afterAll(async () => {
    if (envBefore === undefined) delete process.env.CODE_HOST_GITHUB_API_URL;
    else process.env.CODE_HOST_GITHUB_API_URL = envBefore;
    await server?.close();
    platform?.db.close();
    await gh?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "PUT", url: string, payload?: unknown) => {
    const r = await server.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    return { status: r.statusCode, body: r.body && /^[{[]/.test(r.body) ? r.json() : r.body };
};

/** A model double that records its prompts; its answer goes through the call's schema as a real structured call does. */
function scripted(answer: (prompt: string) => unknown): LlmClient & { prompts: string[] } {
    const prompts: string[] = [];
    return {
        modelName: "scripted",
        model: {} as LlmClient["model"],
        usage: { inputTokens: 0, outputTokens: 0 },
        prompts,
        async object({ prompt, schema }) {
            prompts.push(prompt);
            return schema.parse(answer(prompt));
        },
        async text() {
            throw new Error("not used");
        },
    } as LlmClient & { prompts: string[] };
}
const says = (cls?: string) => () => ({ ...(cls ? { class: cls } : {}), explanation: "The second check ran before the list had loaded.", next: "Rerun with the list's request awaited." });

/** A project, its web test of three checks, and a finding on it (a stored failed run, as failedRunsOf rebuilds one). */
async function seed(name: string, steps: unknown[]) {
    const projectId = String(platform.repo.createProject({ name }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5598", { ...DEFAULT_JOB_OPTIONS }, { username: "qa", password: PW });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Orders", "orders");
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Order page shows its lines", kind: "web", category: "Orders", source: { origin: "browser-agent", requirements: ["R-1"] }, steps });
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "VALIDATED" });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
    const t = platform.repo.getTest(testId)!;
    const vt = { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework };
    const store = new CandidateFindingStore(platform.sql);
    const stored: ScriptRun = { testId: "WEB-001", status: "failed", durationMs: 1, failedStepIndex: 1, steps: [{ index: 0, title: "1. open", status: "passed" }, { index: 1, title: "2. check", status: "failed", error: "Error: expect(locator).toHaveText(expected) failed" }], artifacts: [], responses: [] };
    const [f] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: vt, run: stored }] });
    return { projectId, job, store, finding: f! };
}
const THREE_CHECKS = [
    { action: "navigate", url: "/orders/7" },
    { action: "assert", check: "exactText", locator: { by: "testId", value: "first" }, expected: "Lamp", source: "R-1" },
    { action: "assert", check: "exactText", locator: { by: "testId", value: "second" }, expected: "Desk", source: "R-1" },
    { action: "assert", check: "exactText", locator: { by: "testId", value: "third" }, expected: "Chair", source: "R-1" },
];
/** A failed attempt that stopped at step `at` (0-based), with its artifacts. */
const failedAt = (at: number, artifacts: ScriptRun["artifacts"] = []): ScriptRun => ({
    testId: "WEB-001",
    status: "failed",
    durationMs: 1,
    failedStepIndex: at,
    steps: THREE_CHECKS.slice(0, at + 1).map((_, i) => ({ index: i, title: `${i + 1}. step`, status: i === at ? "failed" : "passed", ...(i === at ? { error: "Error: expect(locator).toHaveText(expected) failed" } : {}) })),
    artifacts,
    responses: [],
});

describe("1. the AI explanation in verification", () => {
    it("explains a finding the rules left open, stores the AI's pick among the candidates at medium confidence, and keeps the explanation", async () => {
        const s = await seed("Explain open", THREE_CHECKS);
        // Two attempts, each failing at another check: the rules leave it open between app_defect and flaky.
        const execute: VerifyDeps["execute"] = async () => [failedAt(1), failedAt(2)];
        const llm = scripted(says("flaky"));
        await verifyFindings({ ...verifyDepsOf(platform, s.job, { execute }), findings: [s.finding], attempts: 2, llm });
        expect(llm.prompts).toHaveLength(1);
        expect(llm.prompts[0]).toContain("Candidate classes: app_defect, flaky");
        const r = (await s.store.get(s.projectId, s.finding.id))!;
        expect(r.findingClass).toBe("flaky");
        expect(r.confidenceDetail!.confidence).not.toBe("high");
        const notes = (await s.store.history(s.projectId, s.finding.id)).map((e) => e.reason ?? "");
        expect(notes.some((n) => n.includes("The second check ran before the list had loaded.") && n.includes("Rerun with the list's request awaited."))).toBe(true);
    });

    it("a class outside the open ones is ignored (the class stays open), and a decided class asks no AI", async () => {
        const s = await seed("Explain ignored", THREE_CHECKS);
        const outside = scripted(says("network"));
        await verifyFindings({ ...verifyDepsOf(platform, s.job, { execute: async () => [failedAt(1), failedAt(2)] }), findings: [s.finding], attempts: 2, llm: outside });
        expect((await s.store.get(s.projectId, s.finding.id))!.findingClass).toBeNull();

        const d = await seed("Explain decided", THREE_CHECKS);
        const never = scripted(says("flaky"));
        // The same check fails in all three attempts against a stated expectation: decided, app_defect.
        await verifyFindings({ ...verifyDepsOf(platform, d.job, { execute: async () => [failedAt(1), failedAt(1), failedAt(1)] }), findings: [d.finding], llm: never });
        expect(never.prompts).toHaveLength(0);
        expect((await d.store.get(d.projectId, d.finding.id))!.findingClass).toBe("app_defect");
    });

    it("an unstated amount the vote reproduced waits for a person: the AI may pick app_defect, but at medium confidence, and the state stays", async () => {
        const s = await seed("Explain review", [{ action: "navigate", url: "/cart" }, { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$30.00", source: "R-1" }]);
        // An exploration's finding on that test: its cited expectation (requirement R-1) states no amount; no API answer was captured.
        const { finding } = await s.store.upsert({
            projectId: s.projectId,
            testId: s.finding.testId,
            finding: {
                objective: { id: "OBJ-aaaaaaaaaaaaaaaa", kind: "rule", source: "R-1" },
                actions: { stepCount: 2 },
                expected: { text: "The cart shows its total.", source: "R-1" },
                observed: "The total shows $40.00.",
                evidence: { screenshots: [], requests: [], console: [] },
                capture: "captured",
                independence: "independent",
                confidence: "high",
                fingerprint: findingFingerprint({ source: "R-1", expected: "The cart shows its total.", scenario: "cart" }),
                modelVersion: null,
                replays: [],
            },
        });
        const llm = scripted(says("app_defect"));
        await verifyFindings({ ...verifyDepsOf(platform, s.job, { execute: async () => [failedAt(1), failedAt(1), failedAt(1)] }), findings: [finding], llm });
        expect(llm.prompts[0]).toContain("Candidate classes: app_defect, incorrect_expectation");
        const r = (await s.store.get(s.projectId, finding.id))!;
        expect(r.state).toBe("needs_manual_review");
        expect(r.findingClass).toBe("app_defect");
        expect(r.confidenceDetail!.confidence).toBe("medium");
    });

    it("picks among the verdict's open classes, not the view's own (eng-fix3's expectation check leaves an unstated amount open)", async () => {
        const v = FindingViewSchema.parse({
            id: "f-1",
            projectId: "p-1",
            source: { kind: "execution", id: "t-1" },
            state: "verification_pending",
            title: "Total",
            testId: "t-1",
            detectedAt: "2026-11-24T10:00:00.000Z",
            expected: { text: "The total is shown.", source: "R-1", stated: "explicit" },
            observed: "It showed $40.00.",
            steps: [],
            attempts: [1, 2, 3].map(() => ({ outcome: "failed", failedStep: 2, check: "exactText", value: "$30.00" })),
            independence: "independent",
        });
        // By the view alone the rules decide app_defect; the expectation check reopens it between app_defect and incorrect_expectation.
        expect(classify(v).class).toBe("app_defect");
        const verdict = { ...classify(v), class: "open" as const, candidates: ["app_defect", "incorrect_expectation"] as const };
        const e = await explainGroup(scripted(says("incorrect_expectation")), [v], { ...verdict, candidates: [...verdict.candidates] });
        expect(e).toMatchObject({ class: "incorrect_expectation", aiClass: true });
        expect(e.confidence.confidence).not.toBe("high");
    });
});

describe("2. root cause from the connected repository", () => {
    async function findingWithFrame(name: string) {
        const s = await seed(name, THREE_CHECKS);
        const attempts = [1, 2].map(() => ({ outcome: "failed", failedStep: 2, check: "exactText", value: "Lamp", stack: ["at total (http://shop.example/src/app.js:4:12)"], requests: [{ method: "GET", path: "/api/orders/7", status: 200, own: true }] }));
        await s.store.transition(s.projectId, s.finding.id, { to: "verification_pending", by: "engine" });
        await s.store.transition(s.projectId, s.finding.id, { to: "unconfirmed", by: "engine", reason: "seeded", set: { attempts } });
        return s;
    }
    const reviewOf = async (projectId: string) => {
        const r = await call("GET", `/api/projects/${projectId}/candidate-findings`);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return r.body.findings[0].review as { cause: { label: string; text: string } | null; noCause: string | null };
    };

    it("finds the likely cause in the project's GitHub repository at its default branch's head", async () => {
        const s = await findingWithFrame("Root cause connected");
        const put = await call("PUT", `/api/projects/${s.projectId}/code-host`, { owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: gh.url });
        expect(put.status, JSON.stringify(put.body)).toBe(201);
        const rv = await reviewOf(s.projectId);
        expect(rv.cause).toMatchObject({ label: "Strongly supported" });
        expect(rv.cause!.text).toContain("src/app.js:3");
        // Read at the head of the default branch, through the stored token only.
        expect(gh.requests.some((q) => q.url.startsWith(`/repos/acme/shop/git/trees/${HEAD}`))).toBe(true);
        expect(gh.requests.every((q) => q.authorization === `Bearer ${GH_TOKEN}`)).toBe(true);
    });

    it("without a connected repository, says so", async () => {
        const s = await findingWithFrame("Root cause none");
        const rv = await reviewOf(s.projectId);
        expect(rv.cause).toBeNull();
        expect(rv.noCause).toMatch(/No code source is connected/);
    });
});

describe("3. response bodies in the evidence package", () => {
    it("keeps the masked, capped bodies of the failing step's requests from the attempt's trace", async () => {
        const s = await seed("Bodies", THREE_CHECKS);
        const ev = path.join(dir, "bodies-ev.json");
        fs.writeFileSync(
            ev,
            JSON.stringify({
                v: 1,
                durationMs: 1,
                counts: { requests: 2, requestsKept: 2, console: 0, consoleKept: 0 },
                steps: [],
                requests: [
                    { t: 1, step: 1, method: "GET", type: "document", path: "/orders/7", status: 200 },
                    { t: 2, step: 2, method: "GET", type: "fetch", path: "/api/orders/7", status: 200 },
                ],
                console: [],
            }),
        );
        const body = JSON.stringify({ id: 7, item: "Lamp", buyer: "ada.lovelace@example.com", password: PW, notes: "n".repeat(20_000) });
        const network = [
            { type: "resource-snapshot", snapshot: { request: { method: "GET", url: "http://127.0.0.1:5598/orders/7" }, response: { status: 200, content: { mimeType: "text/html", _file: "resources/page.html" } } } },
            { type: "resource-snapshot", snapshot: { request: { method: "GET", url: "http://127.0.0.1:5598/api/orders/7?x=1" }, response: { status: 200, content: { mimeType: "application/json", _file: "resources/order.json" } } } },
        ]
            .map((x) => JSON.stringify(x))
            .join("\n");
        const trace = path.join(dir, "bodies-trace.zip");
        fs.writeFileSync(trace, zipSync({ "0-trace.network": strToU8(network), "resources/page.html": strToU8("<html>the page</html>"), "resources/order.json": strToU8(body) }));
        const execute: VerifyDeps["execute"] = async () => [1, 2, 3].map(() => failedAt(1, [{ kind: "evidence", path: ev }, { kind: "trace", path: trace }]));
        const kept: EvidencePackage[] = [];
        const deps = verifyDepsOf(platform, s.job, { execute });
        await verifyFindings({ ...deps, findings: [s.finding], keep: async (f, t, i, file) => (file.json ? (kept.push(file.json as EvidencePackage), "pkg") : "file") });
        expect(kept).toHaveLength(3);
        const bodies = kept[0]!.responseBodies;
        // Only the failing step's request (step 2: the order call), not the page the first step loaded.
        expect(bodies).toHaveLength(1);
        expect(bodies[0]!.request).toBe("GET /api/orders/7 -> 200");
        expect(bodies[0]!.body).toContain('"item":"Lamp"');
        expect(bodies[0]!.body).not.toContain(PW);
        expect(bodies[0]!.body).not.toContain("ada.lovelace@example.com");
        expect(Buffer.byteLength(bodies[0]!.body)).toBeLessThanOrEqual(8 * 1024);
        expect(bodies[0]!.cut).toBe(true);
    });
});

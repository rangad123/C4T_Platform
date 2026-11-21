/**
 * Phase 5 S2: the findings API (routes/findings.ts) through a real platform (Fastify inject, a real database, no model, no browser).
 * One list holds the candidate findings with their lifecycle and the security findings, read only, with the security states mapped
 * (confirmed → Confirmed, probable → Candidate, needs-review → Needs manual review, false-positive → Unconfirmed, fixed → Fixed,
 * accepted-risk → Accepted risk); state, severity and group filter it. A person confirms, says Not a bug (with a reason), splits a
 * group and reopens; a refused move is a 409 with the lifecycle's sentence; a viewer cannot move a finding; another project's finding
 * answers 404 to reading and to moving; a security finding cannot be moved here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { findingFingerprint, type CandidateFindingInput } from "../src/engine/explore/finding.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { fromExecution, SECURITY_STATE } from "../src/platform/findings/adapters.js";
import { classify } from "../src/engine/findings/classify.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { buildServer } from "../src/platform/server.js";
import { VALIDATION_STATES } from "../src/security/contract.js";
import { securityStoreFor } from "../src/security/store.js";
import { seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const KEY = "findings-owner-key-1a2b3c4d";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let A: Seed;
let B: Seed;
let viewer = "";
let store: CandidateFindingStore;

const call = async (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
};
const base = (s: Seed) => `/api/projects/${s.projectId}/findings`;
const move = (s: Seed, fid: string, body: unknown, headers?: Record<string, string>) => call("POST", `${base(s)}/${fid}/transition`, body, headers);

const finding = (scenario: string): CandidateFindingInput => ({
    objective: { id: "obj-1", kind: "rule", source: "R-4" },
    actions: { stepCount: 2 },
    expected: { text: "The total equals the sum of the lines.", source: "R-4" },
    observed: "The total shows 40.00 for two lines of 15.00.",
    evidence: { screenshots: [], requests: [], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: findingFingerprint({ source: "R-4", expected: "The total equals the sum of the lines.", scenario }),
    modelVersion: null,
    replays: [{ label: "Replay 1", outcome: "failed", failedStep: 2, summary: "Stopped at the total check" }],
});
const add = async (s: Seed, scenario: string) => (await store.upsert({ projectId: s.projectId, finding: finding(scenario) })).finding.id;
/** Walks a finding along the engine's path to `to` (reproduced or confirmed), with a high confidence. */
async function walk(s: Seed, id: string, to: "reproduced" | "confirmed", severity = "high") {
    const confidence = { confidence: "high" as const, factors: [] };
    await store.transition(s.projectId, id, { to: "verification_pending", by: "engine" });
    await store.transition(s.projectId, id, { to: "reproduced", by: "engine", set: { severity, confidence: confidence as any } });
    if (to === "confirmed") await store.transition(s.projectId, id, { to: "confirmed", by: "engine" });
}

let secIds: Record<string, string> = {};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-findings-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "findings-test-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
    A = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    B = seedProject(platform, "Other shop", "https://other.example.test");
    store = new CandidateFindingStore(platform.sql);
    const control = accessControlOf(app);
    const u = control.users.create({ email: "vera@example.com", name: "Vera", role: "viewer" });
    viewer = control.users.createToken(u.id, { name: "t", role: "viewer" }).token;
    const sec = securityStoreFor(platform.db);
    const secApp = sec.createApplication(A.projectId, { name: "Atlas", targetUrl: "https://atlas.example.test/", environment: "staging", excludedPaths: [] });
    for (const v of VALIDATION_STATES) {
        const f = sec.upsertFinding({
            projectId: A.projectId, applicationId: secApp.id, assessmentId: null, fingerprint: `fp-${v}`, title: `Missing header (${v})`, category: "headers", severity: "medium", confidence: "high",
            location: "https://atlas.example.test/", description: "No Content-Security-Policy header.", impact: "Scripts from anywhere run.", remediation: "Send a Content-Security-Policy header.",
            evidence: [], source: "built-in", initialValidation: v,
        });
        secIds[v] = f.finding.id;
    }
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/projects/:id/findings", () => {
    it("lists the candidate findings and the security findings in one list, security read only with its states mapped", async () => {
        const id = await add(A, "list one");
        const r = await call("GET", base(A));
        expect(r.status).toBe(200);
        const own = r.body.findings.find((f: any) => f.id === id);
        expect(own).toMatchObject({ source: { kind: "exploration", id }, state: "candidate", readOnly: false, projectId: A.projectId });
        expect(own.attempts.length).toBeGreaterThan(0);
        for (const v of VALIDATION_STATES) {
            const s = r.body.findings.find((f: any) => f.id === secIds[v]);
            expect(s, v).toMatchObject({ source: { kind: "security" }, sourceState: v, state: SECURITY_STATE[v], readOnly: true, severity: "medium" });
        }
        expect(SECURITY_STATE).toEqual({ confirmed: "confirmed", probable: "candidate", "needs-review": "needs_manual_review", "false-positive": "unconfirmed", fixed: "fixed", "accepted-risk": "accepted_risk" });
    });

    it("filters by state, severity and group, and refuses an unknown word", async () => {
        const id = await add(A, "filter one");
        await walk(A, id, "reproduced", "critical");
        const byState = (await call("GET", `${base(A)}?state=reproduced`)).body.findings;
        expect(byState.map((f: any) => f.id)).toEqual([id]);
        const bySev = (await call("GET", `${base(A)}?severity=critical`)).body.findings;
        expect(bySev.map((f: any) => f.id)).toEqual([id]);
        expect((await call("GET", `${base(A)}?state=fixed,accepted_risk`)).body.findings.map((f: any) => f.id).sort()).toEqual([secIds.fixed, secIds["accepted-risk"]].sort());
        const other = await add(A, "filter two");
        const g = await store.group(A.projectId, [id, other], { by: "test" });
        expect((await call("GET", `${base(A)}?group=${g.id}`)).body.findings.map((f: any) => f.id).sort()).toEqual([id, other].sort());
        const bad = await call("GET", `${base(A)}?state=solved`);
        expect(bad.status).toBe(400);
        expect(bad.body.error ?? bad.body.message).toMatch(/Unknown state "solved"/);
    });

    it("answers 404 for another project's finding, by list and by id", async () => {
        const id = await add(A, "isolation");
        expect((await call("GET", base(B))).body.findings.map((f: any) => f.id)).not.toContain(id);
        expect((await call("GET", `${base(B)}/${id}`)).status).toBe(404);
        expect((await call("GET", `${base(B)}/${secIds.confirmed}`)).status).toBe(404);
        expect((await move(B, id, { action: "confirm" })).status).toBe(404);
        expect((await call("GET", `${base(A)}/${id}`)).status).toBe(200);
    });

    it("gets one finding with its attempts and history", async () => {
        const id = await add(A, "detail");
        await walk(A, id, "reproduced");
        const r = await call("GET", `${base(A)}/${id}`);
        expect(r.status).toBe(200);
        expect(r.body.finding.id).toBe(id);
        expect(r.body.history.map((e: any) => e.to)).toEqual(["verification_pending", "reproduced"]);
        expect(Array.isArray(r.body.attempts)).toBe(true);
        const s = await call("GET", `${base(A)}/${secIds["false-positive"]}`);
        expect(s.body.finding).toMatchObject({ readOnly: true, state: "unconfirmed" });
    });
});

describe("POST /api/projects/:id/findings/:fid/transition", () => {
    it("lets a person confirm, say not a bug with a reason, and reopen", async () => {
        const id = await add(A, "person");
        await walk(A, id, "reproduced");
        const c = await move(A, id, { action: "confirm" });
        expect(c.status).toBe(200);
        expect(c.body.finding.state).toBe("confirmed");
        const other = await add(A, "person 2");
        expect((await move(A, other, { action: "not_a_bug" })).status).toBe(409);
        const n = await move(A, other, { action: "not_a_bug", reason: "The page states the old price on purpose." });
        expect(n.body.finding.state).toBe("not_a_bug");
        const back = await move(A, other, { action: "reopen" });
        expect(back.body.finding.state).toBe("candidate");
        const h = (await call("GET", `${base(A)}/${other}`)).body.history;
        expect(h.at(-1)).toMatchObject({ by: "person", from: "not_a_bug", to: "candidate" });
        expect(h.at(-2)).toMatchObject({ by: "person", to: "not_a_bug", reason: "The page states the old price on purpose." });
    });

    it("refuses a move the lifecycle refuses with its sentence", async () => {
        const id = await add(A, "refused");
        const r = await move(A, id, { action: "confirm" });
        expect(r.status).toBe(409);
        expect(r.body.error ?? r.body.message).toMatch(/cannot move from Candidate to Confirmed/);
        expect((await call("GET", `${base(A)}/${id}`)).body.finding.state).toBe("candidate");
    });

    it("splits a finding out of its group, a duplicate back to a candidate", async () => {
        const a = await add(A, "split a");
        const b = await add(A, "split b");
        const g = await store.group(A.projectId, [a, b], { by: "test" });
        await store.transition(A.projectId, b, { to: "duplicate", by: "engine", reason: `Same endpoint and check as ${a}.` });
        const r = await move(A, b, { action: "split" });
        expect(r.status).toBe(200);
        expect(r.body.finding.state).toBe("candidate");
        expect(r.body.finding.groupId).not.toBe(g.id);
        expect((await call("GET", `${base(A)}?group=${g.id}`)).body.findings.map((f: any) => f.id)).toEqual([a]);
        expect((await move(A, a, { action: "split" })).status).toBe(409);
    });

    it("does not let a viewer move a finding, nor anyone move a security finding here", async () => {
        const id = await add(A, "viewer");
        const v = await move(A, id, { action: "not_a_bug", reason: "no" }, { authorization: `Bearer ${viewer}` });
        expect(v.status).toBe(403);
        expect((await call("GET", base(A), undefined, { authorization: `Bearer ${viewer}` })).status).toBe(200);
        const s = await move(A, secIds.confirmed, { action: "not_a_bug", reason: "no" });
        expect(s.status).toBe(409);
        expect(s.body.error ?? s.body.message).toMatch(/Security module/);
        expect((await move(A, id, { action: "approve" })).status).toBe(400);
    });
});

describe("the execution and layer adapter", () => {
    const spec = TestSpecSchema.parse({
        testId: "API-001",
        title: "Order total",
        kind: "api",
        priority: "high",
        expectedResults: ["The order answers its total"],
        steps: [
            { action: "request", method: "GET", path: "/api/orders/7" },
            { action: "assertResponse", check: "status", expected: 200 },
        ],
        source: { origin: "openapi", requirements: ["R-12"] },
    });
    const run = (o: Partial<ScriptRun>): ScriptRun => ({ testId: "t1", status: "failed", durationMs: 10, failedStepIndex: 1, steps: [{ index: 1, title: "status", status: "failed", error: "Error: expect(received).toBe(expected) // 500" }], artifacts: [], responses: [{ method: "GET", path: "/api/orders/7", status: 500 }], ...o });
    const test = { id: "t1", title: "Order total", spec };

    it("reads a failed run as an execution finding, sourced by its failing check, and a Phase 4 test as a layer finding", () => {
        const v = fromExecution({ id: "x1", projectId: "p1", test, runs: [run({}), run({}), run({})], detectedAt: "2026-11-21T10:00:00.000Z" });
        expect(v).toMatchObject({ source: { kind: "execution", id: "t1" }, state: "detected", expected: { source: null, stated: "inferred" }, observed: "Error: expect(received).toBe(expected) // 500", origin: "openapi", priority: "high", requirements: ["R-12"] });
        expect(v.attempts[0]).toMatchObject({ outcome: "failed", failedStep: 2, check: "status", value: "200", requests: [{ method: "GET", path: "/api/orders/7", status: 500, own: true }] });
        // Only the planner's written expectation: reproduced, but not an application defect by the rules.
        expect(classify(v).class).toBe("incorrect_expectation");
        const web = TestSpecSchema.parse({ testId: "WEB-002", title: "Total", kind: "web", steps: [{ action: "navigate", url: "/cart" }, { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$30.00", source: "R-4" }] });
        const wrong = run({ responses: [], steps: [{ index: 1, title: "Total", status: "failed", error: "Error: expect(locator).toHaveText(expected) failed" }] });
        const sourced = fromExecution({ id: "x4", projectId: "p1", test: { id: "t4", title: "Total", spec: web }, runs: [wrong, wrong, wrong], detectedAt: "2026-11-21T10:00:00.000Z" });
        expect(sourced.expected).toMatchObject({ source: "R-4", stated: "explicit" });
        expect(sourced.attempts[0]).toMatchObject({ check: "exactText", target: "total", value: "$30.00" });
        expect(classify(sourced).class).toBe("app_defect");
        const layer = fromExecution({ id: "x2", projectId: "p1", test: { ...test, meta: { layer: "api" } }, runs: [run({})], detectedAt: "2026-11-21T10:00:00.000Z" });
        expect(layer).toMatchObject({ source: { kind: "layer" }, layer: "api" });
    });

    it("marks a run that could not find its element as the test's own step", () => {
        const web = TestSpecSchema.parse({ testId: "WEB-001", title: "Save", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Save" } }] });
        const stuck = run({ failedStepIndex: 1, responses: [], steps: [{ index: 1, title: "Click Save", status: "failed", error: "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Save' })" }] });
        const v = fromExecution({ id: "x3", projectId: "p1", test: { id: "t2", title: "Save", spec: web }, runs: [stuck, stuck, stuck], detectedAt: "2026-11-21T10:00:00.000Z" });
        expect(v.attempts[0]!.stepFault).toMatch(/The test needs fixing/);
        expect(v.expected.stated).toBe("none");
        expect(classify(v).class).toBe("automation");
    });
});

describe("with the Security module turned off", () => {
    it("leaves security findings out of the list and answers 404 for one", async () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-findings-off-"));
        const p = bootstrap(loadConfig({ DATA_DIR: d, SECRET_KEY: "findings-test-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false", SECURITY_ASSESSMENT: "off" }));
        const off = await buildServer(p);
        try {
            await off.ready();
            const s = seedProject(p, "Off shop", "https://off.example.test");
            const sec = securityStoreFor(p.db);
            const a = sec.createApplication(s.projectId, { name: "Off", targetUrl: "https://off.example.test/", environment: "staging", excludedPaths: [] });
            const fid = sec.upsertFinding({ projectId: s.projectId, applicationId: a.id, assessmentId: null, fingerprint: "fp-off", title: "Missing header", category: "headers", severity: "low", confidence: "high", location: "/", description: "d", impact: "i", remediation: "r", evidence: [], source: "built-in" }).finding.id;
            const get = (url: string) => off.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
            expect(JSON.parse((await get(`/api/projects/${s.projectId}/findings`)).body).findings).toEqual([]);
            expect((await get(`/api/projects/${s.projectId}/findings/${fid}`)).statusCode).toBe(404);
        } finally {
            await off.close();
            p.db.close();
            fs.rmSync(d, { recursive: true, force: true });
        }
    });
});

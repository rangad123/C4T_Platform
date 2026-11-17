/**
 * Candidate finding rows (testing-engine Phase 3, P3-13) through a real platform (Fastify inject, a real database, no model, no
 * browser): a defect test saved for review with a candidate finding in its meta gets one candidate_findings row, linked to the test and
 * the run, after the meta went through the runner protocol (agent-protocol/explore-sink.ts); an invalid finding leaves the test saved
 * and the finding skipped with a warning; a pending test makes no row; the row is a candidate, never confirmed; and
 * GET /api/projects/:id/candidate-findings reads with project access, filters by run, and answers 404 for another project.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SinkCall } from "../src/agent-protocol/explore-sink.js";
import { findingFingerprint, type CandidateFindingInput } from "../src/engine/explore/finding.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { buildServer } from "../src/platform/server.js";
import { seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const KEY = "cand-owner-key-8a7b6c5d";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let A: Seed;
let B: Seed;
let viewer = "";

const call = async (url: string, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await app.inject({ method: "GET", url, headers });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null, raw: res.body };
};
const list = (s: Seed, job?: string) => `/api/projects/${s.projectId}/candidate-findings${job ? `?job=${job}` : ""}`;

const finding = (scenario: string, over: Partial<CandidateFindingInput> = {}): CandidateFindingInput => ({
    objective: { id: "obj-1", kind: "rule", source: "R-4" },
    actions: { stepCount: 2 },
    expected: { text: "The total equals the sum of the lines.", source: "R-4" },
    observed: "The total shows 40.00 for two lines of 15.00.",
    evidence: { screenshots: [], requests: ["GET /api/cart -> 200"], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: findingFingerprint({ source: "R-4", expected: "The total equals the sum of the lines.", scenario }),
    modelVersion: null,
    replays: [{ label: "independence 1", outcome: "failed", failedStep: 2, summary: "Stopped at the total check" }],
    ...over,
});

let n = 0;
const spec = (title: string) => TestSpecSchema.parse({ testId: `WEB-${String(++n).padStart(3, "0")}`, title, kind: "web", category: "Cart", steps: [{ action: "navigate", url: "/" }, { action: "navigate", url: "/cart" }] });

/** A sink of a new job of `s`, and a save that goes through the runner protocol's parse first, as a runner's call does. */
async function jobOf(s: Seed) {
    const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
    const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
    const save = async (title: string, validation: "PENDING" | "NEEDS_REVIEW", meta: Record<string, unknown>) => {
        const c = SinkCall.parse({ method: "createTest", spec: spec(title), framework: "playwright", validation, reason: "Found a defect", meta: JSON.parse(JSON.stringify(meta)) });
        if (c.method !== "createTest") throw new Error("not a createTest call");
        const h = await sink.createTest({ spec: c.spec, framework: c.framework as "playwright", validation: c.validation, reason: c.reason, meta: c.meta });
        await sink.writes.flush();
        return h;
    };
    return { job, sink, save };
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cand-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "cand-test-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
    A = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    B = seedProject(platform, "Other shop", "https://other.example.test");
    const control = accessControlOf(app);
    const u = control.users.create({ email: "vera@example.com", name: "Vera", role: "viewer" });
    viewer = control.users.createToken(u.id, { name: "t", role: "viewer" }).token;
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a defect test saved for review", () => {
    it("stores its candidate finding, linked to the test and the run, after the meta crossed the runner protocol", async () => {
        const { job, save } = await jobOf(A);
        const h = await save("Cart total adds up", "NEEDS_REVIEW", { capture: "captured", finding: finding("Cart total adds up") });
        const r = await call(list(A));
        expect(r.status).toBe(200);
        expect(r.body.findings).toHaveLength(1);
        const row = r.body.findings[0];
        expect(row).toMatchObject({ status: "candidate", testId: h.id, firstJobId: job.id, lastJobId: job.id, confidence: "high", capture: "captured", seenCount: 1, projectId: A.projectId });
        expect(row.finding.observed).toBe("The total shows 40.00 for two lines of 15.00.");
        expect(r.raw).not.toMatch(/confirmed/i);
    });

    it("counts the same finding seen again by a later run, and filters by run", async () => {
        const first = (await call(list(A))).body.findings[0];
        const { job, save } = await jobOf(A);
        const h = await save("Cart total adds up", "NEEDS_REVIEW", { capture: "captured", finding: finding("Cart total adds up") });
        const all = (await call(list(A))).body.findings;
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ id: first.id, seenCount: 2, firstJobId: first.firstJobId, lastJobId: job.id, testId: h.id });
        expect((await call(list(A, job.id))).body.findings.map((f: { id: string }) => f.id)).toEqual([first.id]);
        const other = await platform.repo.createJob(A.projectId, A.appId, { ...DEFAULT_JOB_OPTIONS });
        expect((await call(list(A, other.id))).body.findings).toEqual([]);
    });

    it("saves the test and skips an invalid finding with a warning", async () => {
        const { job, save } = await jobOf(B);
        const h = await save("Bad finding", "NEEDS_REVIEW", { capture: "captured", finding: { ...finding("Bad finding"), confidence: "confirmed" } });
        expect(platform.repo.getTest(h.id)?.validationStatus).toBe("NEEDS_REVIEW");
        expect((await call(list(B))).body.findings).toEqual([]);
        const warn = platform.repo.listEvents(job.id).find((e) => e.kind === "finding_skipped");
        expect(warn?.level).toBe("warn");
    });

    it("makes no row for a test that is not waiting for review, nor for one without a finding", async () => {
        const { save } = await jobOf(B);
        await save("Pending one", "PENDING", { capture: "captured", finding: finding("Pending one") });
        await save("No finding", "NEEDS_REVIEW", { capture: "observed_only" });
        expect((await call(list(B))).body.findings).toEqual([]);
    });
});

describe("GET /api/projects/:id/candidate-findings", () => {
    it("answers 404 for an unknown project and for another project's run", async () => {
        expect((await call(`/api/projects/no-such-project/candidate-findings`)).status).toBe(404);
        const { job } = await jobOf(B);
        expect((await call(list(A, job.id))).status).toBe(404);
    });

    it("lets a viewer read, and refuses a request without sign-in", async () => {
        const r = await call(list(A), { authorization: `Bearer ${viewer}` });
        expect(r.status).toBe(200);
        expect(r.body.findings).toHaveLength(1);
        expect((await call(list(A), {})).status).toBe(401);
    });
});

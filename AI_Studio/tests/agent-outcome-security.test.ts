/**
 * The Security Testing Agent's outcome (Agent Workspace W2c, .scratch/agent-workspace/SPEC.md §3, CONTRACT.md):
 *
 *   - GET /api/projects/:id/workspace/security/outcome: its checks (access control, headers, exposure) and its verified findings only,
 *     each with its reproduction; a finding still being verified stays out of the findings, shown on its check instead;
 *   - nothing of another agent: a Responsive UI run in the same project adds nothing here;
 *   - `?run=` answers one run's part, a stopped run's checks included; another agent's run answers 404;
 *   - the Workspace card's headline.
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-outcome-security.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding } from "../src/platform/findings/adapters.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "agent-outcome-security-key-7c2a";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let pid = "";
const ids: Record<string, string> = {};

const call = async (url: string) => {
    const r = await app.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
    return { status: r.statusCode, body: JSON.parse(r.body) } as { status: number; body: any };
};

const spec = (testId: string, title: string, steps: unknown[], kind: "api" | "web" = "api") =>
    TestSpecSchema.parse({ testId, title, kind, type: kind === "api" ? "security" : "visual", priority: "high", steps, expectedResults: [`${title}.`] });
const headers = spec("API-001", "Browser security headers are set (/)", [
    { action: "request", method: "GET", path: "/", auth: "none", description: "Request / (read-only)" },
    { action: "assertResponse", check: "securityHeaders", expected: "csp,frame,nosniff,referrer", description: "Security headers are present" },
]);
const files = spec("API-002", "Secret and source-control files cannot be downloaded", [
    { action: "request", method: "GET", path: "/.env", auth: "none", description: "Request /.env (read-only)" },
    { action: "assertResponse", check: "noExposedFiles", description: "None of these files can be read" },
]);
const access = spec(
    "WEB-001",
    "A visitor cannot open /admin",
    [
        { action: "navigate", url: "/admin", description: "Open /admin signed out" },
        { action: "assert", check: "url", expected: "/login", description: "The visitor is sent to sign in" },
    ],
    "web",
);
const cookies = spec("API-003", "Session cookies are protected (/)", [
    { action: "request", method: "GET", path: "/", auth: "none", description: "Request / (read-only)" },
    { action: "assertResponse", check: "cookieFlags", expected: "httponly,samesite", description: "Session cookies have the protective flags" },
]);
const visual = spec("WEB-002", "Home page looks the same as its approved baseline (/)", [{ action: "navigate", url: "/" }, { action: "assert", check: "screenshot", expected: 100 }], "web");

const failed = (error: string): ScriptRun => ({ testId: "x", status: "failed", durationMs: 10, failedStepIndex: 1, steps: [{ index: 1, title: "check", status: "failed", error }], artifacts: [], responses: [], } as unknown as ScriptRun);

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-sec-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "agent-outcome-security-0123456789" } as never));
    app = await buildServer(platform);
    await app.ready();

    const repo = platform.repo;
    pid = repo.createProject({ name: "Secure shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    await testingAgentsOf(platform).set(pid, ["security", "responsive-ui"] as never, "test");
    const appId = repo.createApplication(pid, "http://127.0.0.1:6533", { ...DEFAULT_JOB_OPTIONS });
    const suite = repo.getOrCreateSuite(pid, "General", "general");
    const job = async (agentId: string) => (await repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, agentId } as never)).id;
    ids.first = await job("security");
    ids.stopped = await job("security");
    ids.visual = await job("responsive-ui");
    // An older run that names no agent, with both agents' switches on: it counts for each, and each keeps only its own tests.
    ids.legacy = (await repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, visual: true })).id;
    const add = (jobId: string, s: typeof headers, status: "VALIDATED" | "NEEDS_REVIEW" | "PENDING", meta: Record<string, unknown>, reason?: string) => {
        const id = repo.insertTest({ projectId: pid, suiteId: suite, jobId, spec: s, framework: s.kind === "api" ? "playwright-api" : "playwright", validationStatus: status, meta });
        if (reason) repo.updateTest(id, { reason });
        return id;
    };
    ids.headers = add(ids.first, headers, "NEEDS_REVIEW", { security: true }, "Security check failed: 2 browser protections are missing.\n- [medium] No Content-Security-Policy.");
    ids.files = add(ids.first, files, "VALIDATED", { security: true });
    ids.access = add(ids.first, access, "NEEDS_REVIEW", { access: true }, "A visitor could open /admin.");
    ids.cookies = add(ids.stopped, cookies, "PENDING", { security: true });
    ids.legacySec = add(ids.legacy, spec("API-004", "The server does not reveal software versions or list folders", [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "noInfoDisclosure" }]), "VALIDATED", { security: true });
    ids.legacyVisual = add(ids.legacy, spec("WEB-005", "Help page looks the same as its approved baseline (/help)", [{ action: "navigate", url: "/help" }, { action: "assert", check: "screenshot", expected: 100 }], "web"), "VALIDATED", { visual: true });
    ids.visualTest = add(ids.visual, visual, "NEEDS_REVIEW", { visual: true }, "The page differs from its approved baseline.");
    repo.setJobStatus(ids.first, "COMPLETED");
    repo.setJobStatus(ids.stopped, "FAILED", "Cancelled");
    repo.setJobStatus(ids.visual, "COMPLETED");
    repo.setJobStatus(ids.legacy, "COMPLETED");

    // The headers problem was verified (three replays failed the same way); the access problem is still being verified; the visual
    // change (Responsive UI's) is verified too, and must not appear here.
    const store = new CandidateFindingStore(platform.sql);
    const finding = async (testId: string, s: typeof headers, error: string, verified: boolean) => {
        const f = (await store.upsert({ projectId: pid, jobId: ids.first, testId, finding: executionFinding({ id: testId, title: s.title, spec: s }, failed(error)) })).finding;
        await store.transition(pid, f.id, { to: "verification_pending", by: "engine" });
        if (verified) {
            const attempt = { outcome: "failed", failedStep: 2, check: s.steps[1]!.action === "assertResponse" ? "securityHeaders" : "url", error };
            await store.transition(pid, f.id, { to: "reproduced", by: "engine", set: { severity: "medium", attempts: [attempt, attempt, attempt] } });
        }
        return f.id;
    };
    ids.headersFinding = await finding(ids.headers, headers, "Security check failed: 2 browser protections are missing.", true);
    ids.accessFinding = await finding(ids.access, access, "Expected /login, got /admin", false);
    ids.visualFinding = await finding(ids.visualTest, visual, "12 pixels are different", true);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Security Testing Agent's outcome", () => {
    it("lists its checks by area and its verified findings with their reproduction, nothing of another agent", async () => {
        const r = await call(`/api/projects/${pid}/workspace/security/outcome`);
        expect(r.status).toBe(200);
        const o = r.body;
        expect(o.runs).toBe(3);
        const byKey = Object.fromEntries(o.checks.map((c: any) => [c.testKey, c]));
        expect(Object.keys(byKey).sort()).toEqual(["API-001", "API-002", "API-003", "API-004", "WEB-001"]);
        expect(byKey["API-001"]).toMatchObject({ area: "headers", result: "problem", finding: { id: ids.headersFinding, state: "reproduced", verified: true } });
        expect(byKey["API-001"].reason).toContain("Content-Security-Policy");
        expect(byKey["API-002"]).toMatchObject({ area: "exposure", result: "passed", reason: null, finding: null });
        expect(byKey["API-003"]).toMatchObject({ area: "headers", result: "not-run" });
        expect(byKey["WEB-001"]).toMatchObject({ area: "access", result: "problem", finding: { id: ids.accessFinding, state: "verification_pending", label: "Verification pending", verified: false } });

        // Verified only: the access problem waits for its verification and is not a finding yet.
        expect(o.findings.map((f: any) => f.id)).toEqual([ids.headersFinding]);
        expect(o.findings[0]).toMatchObject({ testKey: "API-001", area: "headers", label: "Reproduced", severity: "medium", steps: ["Request / (read-only)", "Security headers are present"], reproduced: { same: 3, of: 3 } });
        expect(o.findings[0].observed).toContain("browser protections are missing");

        // Not another agent's: the Responsive UI run's test and its verified finding are absent.
        const all = JSON.stringify(o);
        expect(all).not.toContain("WEB-002");
        expect(all).not.toContain("WEB-005");
        expect(all).not.toContain(ids.visualFinding);
    });

    it("answers one run's part, a stopped run's checks kept, and refuses another agent's run", async () => {
        const first = await call(`/api/projects/${pid}/workspace/security/outcome?run=${ids.first}`);
        expect(first.status).toBe(200);
        expect(first.body.checks.map((c: any) => c.testKey).sort()).toEqual(["API-001", "API-002", "WEB-001"]);
        expect(first.body.findings).toHaveLength(1);
        const stopped = await call(`/api/projects/${pid}/workspace/security/outcome?run=${ids.stopped}`);
        expect(stopped.status).toBe(200);
        expect(stopped.body.checks.map((c: any) => c.testKey)).toEqual(["API-003"]);
        expect(stopped.body.findings).toEqual([]);
        expect((await call(`/api/projects/${pid}/workspace/security/outcome?run=${ids.visual}`)).status).toBe(404);
    });

    it("says on the Workspace card what it found", async () => {
        const ws = await call(`/api/projects/${pid}/workspace`);
        expect(ws.body.agents.find((a: any) => a.id === "security").headline).toBe("1 verified finding, 2 of 5 checks passed");
    });
});

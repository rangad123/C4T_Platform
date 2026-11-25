/**
 * The Security Testing Agent's outcome (Agent Workspace W2c, .scratch/agent-workspace/SPEC.md §3, CONTRACT.md):
 *
 *   - GET /api/projects/:id/workspace/security/outcome: its checks (access control, headers, exposure);
 *   - a rule-based failure (headers, cookies, CORS, HTTPS, exposure) is a fact: each of its problems with its severity, what was
 *     requested and what came back, counted whatever its finding's state (H2, W3-REVIEW.md);
 *   - an access-control problem waits for verification: verified means confirmed, classified or reported, as for the API agent (L1);
 *     only those are findings, each with its reproduction; one still being verified shows how far it got on its check;
 *   - each check names the newest of the agent's runs that made or ran it (its link opens that run, L2);
 *   - a problem a person marked "not a bug" is dismissed, rule-based or access (a person's verdict outranks the verification state):
 *     listed with who said so and why, out of the counts and the headline (as Accessibility, dismissedTests);
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
const secrets = spec("API-005", "Secret and source-control files cannot be downloaded (2)", [
    { action: "request", method: "GET", path: "/.env", auth: "none", description: "Request /.env (read-only)" },
    { action: "request", method: "GET", path: "/.git/HEAD", auth: "none", description: "Request /.git/HEAD (read-only)" },
    { action: "assertResponse", check: "noExposedFiles", description: "None of these files can be read" },
]);
const orders = spec(
    "WEB-003",
    "A visitor cannot open /orders",
    [
        { action: "navigate", url: "/orders", description: "Open /orders signed out" },
        { action: "assert", check: "url", expected: "/login", description: "The visitor is sent to sign in" },
    ],
    "web",
);
const listing = spec("API-006", "The server does not reveal software versions or list folders (2)", [
    { action: "request", method: "GET", path: "/uploads/", auth: "none", description: "Request /uploads/ (read-only)" },
    { action: "assertResponse", check: "noInfoDisclosure", description: "No version banners or directory listings" },
]);
const profile = spec(
    "WEB-004",
    "A visitor cannot open /profile",
    [
        { action: "navigate", url: "/profile", description: "Open /profile signed out" },
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
    ids.secrets = add(ids.first, secrets, "NEEDS_REVIEW", { security: true }, "Security check failed: 2 sensitive files are publicly readable\n- [critical] /.env can be downloaded by anyone (it holds secret settings).\n- [critical] /.git/HEAD can be downloaded by anyone.");
    ids.orders = add(ids.first, orders, "NEEDS_REVIEW", { access: true }, "A visitor could open /orders.");
    ids.profile = add(ids.first, profile, "NEEDS_REVIEW", { access: true }, "A visitor could open /profile.");
    ids.listing = add(ids.first, listing, "NEEDS_REVIEW", { security: true }, "Security check failed: 1 detail about the server is exposed\n- [high] /uploads/ lists the files in a folder (directory listing).");
    ids.cookies = add(ids.stopped, cookies, "PENDING", { security: true });
    ids.legacySec = add(ids.legacy, spec("API-004", "The server does not reveal software versions or list folders", [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "noInfoDisclosure" }]), "VALIDATED", { security: true });
    ids.legacyVisual = add(ids.legacy, spec("WEB-005", "Help page looks the same as its approved baseline (/help)", [{ action: "navigate", url: "/help" }, { action: "assert", check: "screenshot", expected: 100 }], "web"), "VALIDATED", { visual: true });
    ids.visualTest = add(ids.visual, visual, "NEEDS_REVIEW", { visual: true }, "The page differs from its approved baseline.");
    repo.setJobStatus(ids.first, "COMPLETED");
    repo.setJobStatus(ids.stopped, "FAILED", "Cancelled");
    repo.setJobStatus(ids.visual, "COMPLETED");
    repo.setJobStatus(ids.legacy, "COMPLETED");

    // The headers problem was reproduced (three replays failed the same way) but not confirmed; the /admin access problem is still
    // being verified; the /orders one was confirmed; the visual change (Responsive UI's) is verified too, and must not appear here.
    const store = new CandidateFindingStore(platform.sql);
    const finding = async (testId: string, s: typeof headers, error: string, verified: boolean, confirm = false) => {
        const f = (await store.upsert({ projectId: pid, jobId: ids.first, testId, finding: executionFinding({ id: testId, title: s.title, spec: s }, failed(error)) })).finding;
        await store.transition(pid, f.id, { to: "verification_pending", by: "engine" });
        if (verified) {
            const attempt = { outcome: "failed", failedStep: 2, check: s.steps[1]!.action === "assertResponse" ? "securityHeaders" : "url", error };
            await store.transition(pid, f.id, { to: "reproduced", by: "engine", set: { severity: confirm ? "high" : "medium", attempts: [attempt, attempt, attempt] } });
            if (confirm) await store.transition(pid, f.id, { to: "confirmed", by: "person", reason: "Seen it myself." });
        }
        return f.id;
    };
    ids.headersFinding = await finding(ids.headers, headers, "Security check failed: 2 browser protections are missing.", true);
    ids.accessFinding = await finding(ids.access, access, "Expected /login, got /admin", false);
    ids.ordersFinding = await finding(ids.orders, orders, "Expected /login, got /orders", true, true);
    // A rule-based problem a person confirmed: its state shows on its check; it is not listed a second time as a finding.
    ids.secretsFinding = await finding(ids.secrets, secrets, "Security check failed: 2 sensitive files are publicly readable", true, true);
    // A person marked the folder listing not a bug (it is a public downloads folder).
    const listed = (await store.upsert({ projectId: pid, jobId: ids.first, testId: ids.listing, finding: executionFinding({ id: ids.listing, title: listing.title, spec: listing }, failed("Security check failed: 1 detail about the server is exposed")) })).finding;
    await store.transition(pid, listed.id, { to: "not_a_bug", by: "person", actor: { label: "Asha" }, reason: "It is our public downloads folder." });
    // A person marked the /profile access problem not a bug while it was being verified (the page is public by design).
    const prof = (await store.upsert({ projectId: pid, jobId: ids.first, testId: ids.profile, finding: executionFinding({ id: ids.profile, title: profile.title, spec: profile }, failed("Expected /login, got /profile")) })).finding;
    await store.transition(pid, prof.id, { to: "verification_pending", by: "engine" });
    await store.transition(pid, prof.id, { to: "not_a_bug", by: "person", actor: { label: "Asha" }, reason: "Profiles are public by design." });
    ids.visualFinding = await finding(ids.visualTest, visual, "12 pixels are different", true, true);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Security Testing Agent's outcome", () => {
    it("lists its checks by area, rule-based problems as facts with evidence, verified access findings with their reproduction, nothing of another agent", async () => {
        const r = await call(`/api/projects/${pid}/workspace/security/outcome`);
        expect(r.status).toBe(200);
        const o = r.body;
        expect(o.runs).toBe(3);
        const byKey = Object.fromEntries(o.checks.map((c: any) => [c.testKey, c]));
        expect(Object.keys(byKey).sort()).toEqual(["API-001", "API-002", "API-003", "API-004", "API-005", "API-006", "WEB-001", "WEB-003", "WEB-004"]);
        // An access problem a person marked not a bug: dismissed too, not "not verified yet".
        expect(byKey["WEB-004"]).toMatchObject({ area: "access", result: "problem", dismissed: "A person marked this not a bug: Profiles are public by design." });
        expect(byKey["WEB-001"].dismissed).toBeNull();
        // Dismissed: listed with the person's reason, its high problem left out of the counts below.
        expect(byKey["API-006"]).toMatchObject({ result: "problem", dismissed: "A person marked this not a bug: It is our public downloads folder." });
        expect(byKey["API-001"].dismissed).toBeNull();
        // Reproduced is not verified (L1): the API agent's meaning.
        expect(byKey["API-001"]).toMatchObject({ area: "headers", result: "problem", severity: "medium", finding: { id: ids.headersFinding, state: "reproduced", verified: false } });
        expect(byKey["API-001"].reason).toContain("Content-Security-Policy");
        // A rule-based failure is a fact: its problems with their severity, what was requested and what came back.
        expect(byKey["API-001"]).toMatchObject({ problems: [{ severity: "medium", text: "No Content-Security-Policy." }], requested: ["GET /"], jobId: ids.first });
        expect(byKey["API-005"]).toMatchObject({
            area: "exposure",
            result: "problem",
            severity: "critical",
            finding: { id: ids.secretsFinding, state: "confirmed", verified: true },
            requested: ["GET /.env", "GET /.git/HEAD"],
            problems: [
                { severity: "critical", text: "/.env can be downloaded by anyone (it holds secret settings)." },
                { severity: "critical", text: "/.git/HEAD can be downloaded by anyone." },
            ],
        });
        expect(byKey["API-002"]).toMatchObject({ area: "exposure", result: "passed", reason: null, finding: null, problems: [], severity: null });
        expect(byKey["API-003"]).toMatchObject({ area: "headers", result: "not-run", jobId: ids.stopped });
        // The legacy run made it, and no newer run of this agent ran it.
        expect(byKey["API-004"]).toMatchObject({ jobId: ids.legacy });
        // An access problem is not a fact: it shows how far its verification got, and lists no rule-based problems.
        expect(byKey["WEB-001"]).toMatchObject({ area: "access", result: "problem", problems: [], finding: { id: ids.accessFinding, state: "verification_pending", label: "Verification pending", verified: false } });
        expect(byKey["WEB-003"]).toMatchObject({ area: "access", result: "problem", severity: "high", finding: { id: ids.ordersFinding, state: "confirmed", verified: true } });

        // Findings: the verified access problems only (a rule-based problem is listed on its check, not twice).
        expect(o.findings.map((f: any) => f.id)).toEqual([ids.ordersFinding]);
        expect(o.findings[0]).toMatchObject({ testKey: "WEB-003", area: "access", label: "Confirmed", severity: "high", steps: ["Open /orders signed out", "The visitor is sent to sign in"], reproduced: { same: 3, of: 3 } });
        expect(o.findings[0].observed).toContain("got /orders");
        // Counted: every rule-based problem by its severity, a verified access finding by its own, the rest as not verified yet.
        expect(o.counts).toEqual({ critical: 2, high: 1, medium: 1, low: 0, notVerified: 1 });

        // Not another agent's: the Responsive UI run's test and its verified finding are absent.
        const all = JSON.stringify(o);
        expect(all).not.toContain("WEB-002");
        expect(all).not.toContain("WEB-005");
        expect(all).not.toContain(ids.visualFinding);
    });

    it("answers one run's part, a stopped run's checks kept, and refuses another agent's run", async () => {
        const first = await call(`/api/projects/${pid}/workspace/security/outcome?run=${ids.first}`);
        expect(first.status).toBe(200);
        expect(first.body.checks.map((c: any) => c.testKey).sort()).toEqual(["API-001", "API-002", "API-005", "API-006", "WEB-001", "WEB-003", "WEB-004"]);
        expect(first.body.findings).toHaveLength(1);
        const stopped = await call(`/api/projects/${pid}/workspace/security/outcome?run=${ids.stopped}`);
        expect(stopped.status).toBe(200);
        expect(stopped.body.checks.map((c: any) => c.testKey)).toEqual(["API-003"]);
        expect(stopped.body.findings).toEqual([]);
        expect(stopped.body.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, notVerified: 0 });
        expect((await call(`/api/projects/${pid}/workspace/security/outcome?run=${ids.visual}`)).status).toBe(404);
    });

    it("shows an older run's own result on its page, from that run's executions, and the newest run's the current one", async () => {
        const repo = platform.repo;
        const hp = repo.createProject({ name: "History shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
        await testingAgentsOf(platform).set(hp, ["security"] as never, "test");
        const appId = repo.createApplication(hp, "http://127.0.0.1:6535", { ...DEFAULT_JOB_OPTIONS });
        const suite = repo.getOrCreateSuite(hp, "General", "general");
        const older = (await repo.createJob(hp, appId, { ...DEFAULT_JOB_OPTIONS, agentId: "security" } as never)).id;
        const cors = spec("API-001", "Cross-origin access (CORS) is not wide open", [
            { action: "request", method: "GET", path: "/", headers: { Origin: "https://untrusted-origin.example" }, description: "Request / from another origin (read-only)" },
            { action: "assertResponse", check: "corsPolicy", description: "The made-up origin is not trusted" },
        ]);
        const tls = spec("API-002", "The HTTPS certificate is valid and not about to expire", [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "tlsCertificate", expected: 14 }]);
        const ids2 = { cors: repo.insertTest({ projectId: hp, suiteId: suite, jobId: older, spec: cors, framework: "playwright-api", validationStatus: "VALIDATED", meta: { security: true } }), tls: repo.insertTest({ projectId: hp, suiteId: suite, jobId: older, spec: tls, framework: "playwright-api", validationStatus: "VALIDATED", meta: { security: true } }) };
        const exec = (testId: string, jobId: string, status: string, at: string, steps: Array<{ index: number; title: string; status: string; error?: string }>, error?: string) =>
            repo.addExecution({ testId, scriptId: null, jobId, attempt: 1, status, durationMs: 10, startedAt: at, steps, ...(error ? { error } : {}) });
        // The older run: CORS found a problem (the check's own message), TLS could not connect (not a finding).
        exec(ids2.cors, older, "failed", "2026-11-20T10:00:00.000Z", [{ index: 0, title: "Request /", status: "passed" }, { index: 1, title: "The made-up origin is not trusted", status: "failed", error: "Error: Security check failed: 1 cross-origin problem.\n- [high] The server echoes any Origin with credentials allowed." }]);
        exec(ids2.tls, older, "failed", "2026-11-20T10:00:01.000Z", [{ index: 0, title: "Request /", status: "failed", error: "connect ECONNREFUSED 127.0.0.1:6535" }], "connect ECONNREFUSED 127.0.0.1:6535");
        repo.setJobStatus(older, "COMPLETED");
        // The newer run: both pass now.
        const newer = (await repo.createJob(hp, appId, { ...DEFAULT_JOB_OPTIONS, agentId: "security" } as never)).id;
        exec(ids2.cors, newer, "passed", "2026-11-21T10:00:00.000Z", []);
        exec(ids2.tls, newer, "passed", "2026-11-21T10:00:01.000Z", []);
        // A list check the validator judged a problem by another rule: the newest run's page keeps the validator's verdict.
        const list = spec("WEB-001", "Another account's orders stay closed", [{ action: "request", method: "GET", path: "/api/orders" }, { action: "assertResponse", check: "status", expected: 403 }]);
        const listId = repo.insertTest({ projectId: hp, suiteId: suite, jobId: newer, spec: list, framework: "playwright-api", validationStatus: "NEEDS_REVIEW", meta: { access: true } });
        repo.updateTest(listId, { reason: "Another account's orders were listed." });
        exec(listId, newer, "failed", "2026-11-21T10:00:02.000Z", [{ index: 1, title: "status", status: "failed", error: "Expected 403, got 200" }]);
        repo.setJobStatus(newer, "COMPLETED");

        const result = async (q: string) => Object.fromEntries((await call(`/api/projects/${hp}/workspace/security/outcome${q}`)).body.checks.map((c: any) => [c.testKey, c]));
        const old = await result(`?run=${older}`);
        expect(old["API-001"]).toMatchObject({ result: "problem" });
        expect(old["API-001"].reason).toContain("echoes any Origin");
        // That run's own problem, as a fact.
        expect(old["API-001"]).toMatchObject({ severity: "high", problems: [{ severity: "high", text: "The server echoes any Origin with credentials allowed." }], jobId: older });
        expect(old["API-002"]).toMatchObject({ result: "could-not-check" });
        expect(old["API-002"].reason).toContain("ECONNREFUSED");
        const now = await result(`?run=${newer}`);
        expect([now["API-001"].result, now["API-002"].result]).toEqual(["passed", "passed"]);
        expect(now["WEB-001"]).toMatchObject({ result: "problem", reason: "Another account's orders were listed." });
        const all = await result("");
        expect([all["API-001"].result, all["API-002"].result]).toEqual(["passed", "passed"]);
        // On the outcome each check names the newest run that ran it.
        expect([all["API-001"].jobId, all["WEB-001"].jobId]).toEqual([newer, newer]);
    });

    it("says on the Workspace card what it found", async () => {
        const ws = await call(`/api/projects/${pid}/workspace`);
        // The critical and high problems are not hidden behind "no verified findings" (H2).
        expect(ws.body.agents.find((a: any) => a.id === "security").headline).toBe("2 critical, 1 high, 1 medium, 1 access problem not verified yet, 2 of 9 checks passed");
    });
});

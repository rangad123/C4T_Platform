/**
 * The whole workflow, end to end, against the platform's own deliberately vulnerable fixture and a REAL ZAP daemon: register an
 * application, record who authorized it, allow ZAP for the project, start an assessment through the ordinary API, and read back what ZAP
 * actually found.
 *
 * This is the test that proves the scanner layer is actually WIRED IN. Every other scanner test drives an adapter directly, which cannot
 * tell whether an assessment started through the platform's own API ever calls one - and for a while it did not.
 *
 * Skipped unless every input is present, because none of it can be faked into meaning anything:
 *   SECURITY_E2E_FIXTURE_URL=http://127.0.0.1:5310   (node examples/security-fixture/server.mjs 5310)
 *   SECURITY_ZAP_URL=http://127.0.0.1:8090            (a ZAP daemon with its API open)
 *   SECURITY_ZAP_API_KEY=<that daemon's key>
 *
 * Fastify inject only: no port is opened for the platform, and the fixture and the daemon are the operator's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { assessmentLoopOf } from "../src/security/routes/assessments.js";
import { FINISHED_STATES } from "../src/security/contract.js";

const FIXTURE = process.env.SECURITY_E2E_FIXTURE_URL;
const ZAP_URL = process.env.SECURITY_ZAP_URL;
const ZAP_KEY = process.env.SECURITY_ZAP_API_KEY;
const ready = Boolean(FIXTURE && ZAP_URL && ZAP_KEY);
const describeIf = ready ? describe : describe.skip;

const KEY = "sec-e2e-key-0123456789";
const API = "/api/v1/security";
const dirs: string[] = [];
const FINISHED = new Set<string>(FINISHED_STATES);

/** Read one assessment until it reaches a terminal state, exactly as a client watching the screen would. Never fails silently. */
const waitForTerminal = async (call: Call, id: string, budgetMs: number): Promise<any> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        const r = await call("GET", `${API}/assessments/${id}`);
        expect(r.status).toBe(200);
        const a = r.body.assessment;
        if (FINISHED.has(a.state)) return a;
        expect(Date.now(), `the assessment never finished: last state ${a.state} (${a.progressText ?? ""})`).toBeLessThan(deadline);
        await new Promise((r2) => setTimeout(r2, 500));
    }
};

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
const caller =
    (app: FastifyInstance): Call =>
    async (method, url, body) => {
        const r = await app.inject({ method: method as never, url, headers: { "x-api-key": KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
        let parsed: unknown = r.body;
        try {
            parsed = JSON.parse(r.body);
        } catch {
            /* not JSON */
        }
        return { status: r.statusCode, body: parsed };
    };

describeIf("a real assessment, through the platform's own API, against a real ZAP daemon", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let call: Call;
    let projectId: string;
    let applicationId: string;

    beforeAll(async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-e2e-"));
        dirs.push(dataDir);
        platform = bootstrap(
            loadConfig({
                DATA_DIR: dataDir,
                SCHEDULER_ENABLED: "false",
                // WORKER_EMBEDDED is left at its default (on) on purpose: the embedded assessment loop is the production path, and
                // this test must prove the ordinary one works rather than proving a hand-driven loop does.
                API_KEY: KEY,
                SECURITY_SCANNERS: "zap",
                SECURITY_SCANNER_MAX_RPS: "5",
                SECURITY_ZAP_URL: ZAP_URL!,
                SECURITY_ZAP_API_KEY: ZAP_KEY!,
                // The fixture is on 127.0.0.1, which the scope guard always refuses unless this is switched on. That the guard is on by
                // default is the point; a test that needs it off says so.
                SECURITY_ALLOW_PRIVATE_TARGETS: "true",
            }),
        );
        app = await buildServer(platform);
        await app.ready();
        call = caller(app);
        const users = accessControlOf(app).users;
        users.create({ email: "owner@example.com", name: "Owner", role: "owner" });
        const created0 = await call("POST", "/api/projects", { name: "E2E client" });
        projectId = created0.body.id;

        // 1 + 2. Register the application and record who authorized it.
        const created = await call("POST", `${API}/projects/${projectId}/applications`, {
            name: "Security fixture",
            targetUrl: FIXTURE!,
            environment: "other",
            scope: [FIXTURE!],
            excludedPaths: ["/admin"],
            maxRequestsPerSecond: 3,
        });
        expect(created.status, `creating the application failed: ${JSON.stringify(created.body)}`).toBe(201);
        applicationId = created.body.application.id;

        // The application exists but nothing may be assessed until someone has recorded WHY it may be. This is a separate,
        // deliberate act, not something that happens when the application is added.
        expect(created.body.authorization.state, "a fresh application must have no authorization yet").toBe("none");
        const authorized = await call("POST", `${API}/applications/${applicationId}/authorizations`, {
            basis: "owner",
            approverName: "E2E Owner",
            documentReference: "E2E-1",
            confirm: true,
        });
        expect(authorized.status, `recording the authorization failed: ${JSON.stringify(authorized.body)}`).toBe(201);
        expect(authorized.body.state.state, "the recorded authorization must cover exactly what was registered").toBe("current");

        // Allow ZAP for this project: the second gate.
        const allow = await call("PUT", `${API}/projects/${projectId}/scanners`, { enabled: ["zap"] });
        expect(allow.status).toBe(200);
        expect(allow.body.allowed).toContain("zap");
    }, 120_000);

    afterAll(async () => {
        await app?.close().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 250));
        for (const d of dirs) {
            try {
                fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            } catch {
                /* a Windows file handle can outlive the server; the temp dir is left for the OS to clean */
            }
        }
    });

    it("the health view says ZAP is usable before anything is started", async () => {
        const r = await call("GET", `${API}/projects/${projectId}/scanners?profile=passive&applicationId=${applicationId}`);
        expect(r.status).toBe(200);
        const zap = (r.body.scanners as { id: string; status: string; reason?: string }[]).find((s) => s.id === "zap");
        expect(zap, `the health view must name ZAP: ${JSON.stringify(r.body)}`).toBeTruthy();
        expect(zap!.status, `ZAP health: ${zap!.reason ?? ""}`).toBe("available");
    }, 60_000);

    it("starts an assessment through the ordinary API and it runs the real scanner", async () => {
        const started = await call("POST", `${API}/applications/${applicationId}/assessments`, {});
        expect(started.status, `starting the assessment failed: ${JSON.stringify(started.body)}`).toBe(201);
        const id = started.body.assessment.id;

        // Nothing in this test drives the assessment. The embedded loop - the same one production uses - must claim it by itself,
        // which is the only way this proves the scanner layer is reachable from the ordinary API rather than from a test harness.
        expect(assessmentLoopOf(platform.db), "the platform must have an embedded assessment loop").toBeTruthy();
        const assessment = await waitForTerminal(call, id, 240_000);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"], `the assessment ended ${assessment.state}: ${assessment.error ?? assessment.progressText ?? ""}`).toContain(assessment.state);

        // The scanner ran: the assessment carries one run per tool, with what it did and did not cover.
        const scans = await call("GET", `${API}/assessments/${id}/scans`);
        expect(scans.status).toBe(200);
        const zapRun = (scans.body.runs as { scanner: string; state: string; findingsCount: number; error: string | null }[]).find((r) => r.scanner === "zap");
        expect(zapRun, `ZAP must have a run recorded against this assessment; runs: ${JSON.stringify(scans.body.runs)}`).toBeTruthy();
        expect(zapRun!.state, `ZAP's own run did not complete: ${zapRun!.error ?? "(no reason given)"}`).toBe("COMPLETED");
        expect(zapRun!.findingsCount, `ZAP reported nothing: ${JSON.stringify(scans.body.runs)}`).toBeGreaterThan(0);

        // Its alerts reached the ordinary findings list, marked as a scanner's and not as the platform's own verdict.
        const findings = await call("GET", `${API}/projects/${projectId}/findings?application=${applicationId}&limit=200`);
        expect(findings.status).toBe(200);
        const zapFindings = findings.body.findings.filter((f: { source: string }) => f.source === "external");
        const seen = JSON.stringify(zapFindings.map((f: { checkId: string; title: string; location: string }) => ({ rule: f.checkId, at: f.location, title: f.title })));
        expect(zapFindings.length, `ZAP's real alerts must reach the findings list. ZAP reported ${zapRun!.findingsCount}; stored external findings: ${seen}`).toBeGreaterThan(0);
        // No alert may be silently lost: every stored external finding must be one ZAP actually reported, and the count may only be
        // lower than the tool's own because two of its rules described one problem at one address (the ingest that folds them).
        expect(zapFindings.length, `stored more findings than ZAP reported (${zapRun!.findingsCount}); stored: ${seen}`).toBeLessThanOrEqual(zapRun!.findingsCount);

        // Each one is evidence-backed and names ZAP's own rule.
        for (const f of zapFindings) {
            expect(f.title).toBeTruthy();
            expect(f.checkId, "an external finding records the tool that reported it").toBe("zap");
            expect(String(f.location)).not.toMatch(/\/admin/);
            expect(f.evidence.length, `${f.title} kept no evidence`).toBeGreaterThan(0);
            // The tool's own rule id stays readable, so a reviewer can look it up in that tool's documentation.
            expect(f.evidence.map((e: { value: string }) => e.value).join("\n"), `${f.title} lost the rule id`).toMatch(/alert \d+/i);
            // A scanner finding is evidence, never a verdict: it may start as probable, which the interface words as "the evidence
            // points to a real problem; a person has not confirmed it yet". It is never `confirmed` - only a person can do that.
            expect(["needs-review", "probable"], `${f.title} started as ${f.validation}`).toContain(f.validation);
            expect(f.validation, "nothing a scanner said may be marked confirmed on the platform's own authority").not.toBe("confirmed");
        }

        // The report says ZAP ran and says what it did not cover.
        const report = await call("GET", `${API}/assessments/${id}/report`);
        expect(report.status).toBe(200);
        expect(JSON.stringify(report.body)).toMatch(/zap/i);
    }, 300_000);

    it("the evidence of one finding is readable on its own, and says what to do about it", async () => {
        const findings = await call("GET", `${API}/projects/${projectId}/findings?application=${applicationId}&limit=200`);
        const zapFinding = findings.body.findings.find((f: { source: string }) => f.source === "external");
        expect(zapFinding, "the earlier test must have stored at least one ZAP finding").toBeTruthy();
        const one = await call("GET", `${API}/findings/${zapFinding.id}`);
        expect(one.status).toBe(200);
        // Evidence is not a summary of evidence: the record has to carry what ZAP actually matched on.
        expect(one.body.finding.evidence.length, "a scanner finding must keep its evidence").toBeGreaterThan(0);
        expect(one.body.finding.remediation, "ZAP states a fix for every rule it raises; it must be kept").toBeTruthy();
        // Nothing a scanner reports is confirmed on the platform's own authority; a person has to judge it.
        expect(["needs-review", "probable"], `a scanner finding started as ${one.body.finding.validation}`).toContain(one.body.finding.validation);
        expect(one.body.finding.validation).not.toBe("confirmed");
        expect(one.body.finding.source, "the finding must say an outside tool reported it").toBe("external");
    }, 60_000);

    it("cancels an assessment that is genuinely running, and cleans up after it", async () => {
        // A target that takes 30 seconds to answer, so the assessment is really mid-crawl when the cancel lands rather than racing a
        // target that finishes first. Cancelling a finished job would prove nothing.
        const slow = await call("POST", `${API}/projects/${projectId}/applications`, {
            name: "Slow fixture",
            targetUrl: `${FIXTURE}/slow?ms=30000`,
            environment: "other",
            // No extra scope: the target address itself is the scope. `scope` takes origins only, never a path.
            scope: [],
            maxRequestsPerSecond: 3,
        });
        expect(slow.status, `creating the slow application failed: ${JSON.stringify(slow.body)}`).toBe(201);
        const slowId = slow.body.application.id;
        const ok = await call("POST", `${API}/applications/${slowId}/authorizations`, { basis: "owner", approverName: "E2E Owner", confirm: true });
        expect(ok.status).toBe(201);

        const started = await call("POST", `${API}/applications/${slowId}/assessments`, {});
        expect(started.status, `starting the slow assessment failed: ${JSON.stringify(started.body)}`).toBe(201);
        const id = started.body.assessment.id;

        // Cancel only once the loop has actually claimed the job: a cancel that lands while the assessment is merely queued proves
        // much less, because nothing has been requested yet.
        const deadline = Date.now() + 60_000;
        for (;;) {
            const r = await call("GET", `${API}/assessments/${id}`);
            const a = r.body.assessment;
            if (FINISHED.has(a.state)) throw new Error(`the slow assessment finished (${a.state}) before it could be cancelled; the target was too fast`);
            if (a.state !== "QUEUED" || a.cancelRequested) break;
            if (Date.now() > deadline) throw new Error(`the loop never picked the slow assessment up; last state ${a.state}`);
            await new Promise((r2) => setTimeout(r2, 100));
        }

        const cancelled = await call("POST", `${API}/assessments/${id}/cancel`, {});
        expect(cancelled.status).toBe(202);
        expect(cancelled.body.assessment.cancelRequested, "the record must show the cancel was asked for").toBe(true);

        const done = await waitForTerminal(call, id, 60_000);
        expect(done.state, "a cancelled assessment must end CANCELLED, never quietly finish as if nothing happened").toBe("CANCELLED");
        expect(done.finishedAt, "a cancelled assessment is finished, so it has an end time").toBeTruthy();

        // Cleanup: nothing is left holding the application, and it can be assessed again.
        const after = await call("GET", `${API}/applications/${slowId}`);
        expect(after.body.activeAssessmentId, "a cancelled assessment must not stay active").toBeNull();
        const again = await call("POST", `${API}/applications/${slowId}/assessments`, {});
        expect(again.status, "the application must be free for a new assessment once the cancelled one is done").toBe(201);
        await call("POST", `${API}/assessments/${again.body.assessment.id}/cancel`, {});
    }, 180_000);

    it("leaves the functional testing side untouched", async () => {
        // The two pipelines share a project but nothing else. A security assessment must not queue, start or alter a functional test
        // run, and a scanner finding must not appear as a functional test result.
        const jobs = await call("GET", `/api/projects/${projectId}/jobs`);
        expect(jobs.status).toBe(200);
        expect(jobs.body, "a security assessment must never create a functional validation job").toEqual([]);

        // And the security findings are the platform's own records: the tool that reported one is named on it, so nothing downstream
        // can mistake a scanner's opinion for a functional test result or for the platform's own verdict.
        const findings = await call("GET", `${API}/projects/${projectId}/findings?limit=200`);
        expect(findings.body.findings.length).toBeGreaterThan(0);
        for (const f of findings.body.findings) {
            expect(["built-in", "manual", "external"], `unexpected finding source ${f.source}`).toContain(f.source);
            if (f.source === "external") expect(["zap", "nuclei", "schemathesis", "promptfoo"], "an external finding names the tool that reported it").toContain(f.checkId);
            else expect(f.checkId, "a platform finding keeps its own check id").toBeTruthy();
            // Nothing on the security side points at the functional pipeline.
            expect(f.testId ?? f.jobId ?? null, "a security finding must not reference a functional run").toBeNull();
        }
    }, 60_000);
});
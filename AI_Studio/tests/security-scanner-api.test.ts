/**
 * Security Assessment, SCAN through the real platform server (Fastify inject, no network, no browser): who may read what the scanners
 * can do and who may allow one for a project, the two gates (platform switch AND project allow-list) both showing up in the answer, the
 * reviewed AI evaluation cases being listed so a client can read them before consenting, the profiles being described in plain words with
 * the environment they were judged against, and two projects never seeing each other's scanners or runs.
 *
 * No tool is started and no port is opened: nothing here calls an adapter's `start`, and no binary is run. Run:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-scanner-api.test.ts
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
import { createRun, updateRun } from "../src/security/scanners/store.js";

const KEY = "sec-scan-key-0123456789";
const API = "/api/v1/security";
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-scan-api-"));
    dirs.push(d);
    return d;
};

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
const caller =
    (app: FastifyInstance, key: string): Call =>
    async (method, url, body) => {
        const r = await app.inject({ method: method as never, url, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
        let parsed: unknown = r.body;
        try {
            parsed = JSON.parse(r.body);
        } catch {
            /* not JSON */
        }
        return { status: r.statusCode, body: parsed };
    };

describe("security assessment SCAN API", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let key: Call;
    let owner: Call;
    let editor: Call;
    let viewer: Call;
    let pA: string;
    let pB: string;

    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECURITY_SCANNERS: "zap,nuclei", SECURITY_SCANNER_MAX_RPS: "5" }));
        app = await buildServer(platform);
        await app.ready();
        const users = accessControlOf(app).users;
        const person = (name: string, role: "owner" | "editor" | "viewer") => {
            const u = users.create({ email: `${name.toLowerCase()}@example.com`, name, role });
            return caller(app, users.createToken(u.id, { name: "t", role }).token);
        };
        key = caller(app, KEY);
        owner = person("Olga", "owner");
        editor = person("Eve", "editor");
        viewer = person("Vic", "viewer");
        pA = (await key("POST", "/api/projects", { name: "Client A" })).body.id;
        pB = (await key("POST", "/api/projects", { name: "Client B" })).body.id;
    }, 60_000);
    afterAll(async () => {
        await app?.close();
        platform?.db.close();
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    });

    const shop = { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging", excludedPaths: ["/admin"] };
    const authBody = { basis: "owner", approverName: "Dana", confirm: true };

    let appId: string;
    let appB: string;
    let assessmentId: string;
    let assessmentB: string;
    /** An application, an authorization and an assessment of one project: the three things a scan run refers to. */
    const withAssessment = async (projectId: string, application: Record<string, unknown>) => {
        const id = (await editor("POST", `${API}/projects/${projectId}/applications`, application)).body.application.id;
        const authorization = (await owner("POST", `${API}/applications/${id}/authorizations`, authBody)).body.authorization;
        const assessment = await editor("POST", `${API}/applications/${id}/assessments`, {});
        expect(assessment.status).toBe(201);
        return { id, assessmentId: assessment.body.assessment.id as string };
    };
    it("registers an application and its authorization, so an assessment can exist", async () => {
        const a = await withAssessment(pA, shop);
        appId = a.id;
        assessmentId = a.assessmentId;
        const b = await withAssessment(pB, { ...shop, name: "B site", targetUrl: "https://b.example.com/" });
        appB = b.id;
        assessmentB = b.assessmentId;
    });

    it("names every known scanner and says which two gates are still shut", async () => {
        const r = await viewer("GET", `${API}/projects/${pA}/scanners`);
        expect(r.status).toBe(200);
        expect(r.body.profile).toBe("passive");
        expect(r.body.allowed).toEqual([]);
        // All four are known, none is allowed for this project yet, and each says why in its own words.
        expect(r.body.scanners.map((s: { id: string }) => s.id).sort()).toEqual(["nuclei", "promptfoo", "schemathesis", "zap"]);
        expect(r.body.scanners.find((s: { id: string }) => s.id === "zap")).toMatchObject({ status: "not-allowed", supportsProfile: false });
        expect(r.body.scanners.find((s: { id: string }) => s.id === "zap").reason).toMatch(/not allowed for this project/);
        expect(r.body.scanners.find((s: { id: string }) => s.id === "zap").remedy).toMatch(/Nothing runs a scanner that is not allowed for the project/);
        // Installed but not named in SECURITY_SCANNERS is off, which is a different sentence from "not allowed".
        expect(r.body.scanners.find((s: { id: string }) => s.id === "promptfoo")).toMatchObject({ status: "off", supportsProfile: false });
        expect(r.body.scanners.find((s: { id: string }) => s.id === "promptfoo").remedy).toMatch(/SECURITY_SCANNERS/);
    });

    it("tells a client what each tool is for, and what it does not cover", async () => {
        const r = await viewer("GET", `${API}/projects/${pA}/scanners`);
        const zap = r.body.scanners.find((s: { id: string }) => s.id === "zap");
        expect(zap.covers).toMatch(/Not covered: broken access control/);
        expect(zap.purpose).toMatch(/missing headers/i);
        for (const s of r.body.scanners) {
            expect(s.covers).toMatch(/Not covered:/);
            expect(s.documentationUrl).toMatch(/^https:\/\//);
        }
    });

    it("lists the reviewed AI cases so they can be read before anyone consents to them", async () => {
        const r = await viewer("GET", `${API}/projects/${pA}/scanners`);
        expect(r.body.aiCases.length).toBeGreaterThan(4);
        for (const c of r.body.aiCases) {
            expect(c.id).toMatch(/^[a-z0-9-]+$/);
            expect(c.what.length).toBeGreaterThan(10);
        }
        const platform2 = await viewer("GET", `${API}/scanners`);
        expect(platform2.body.aiCases).toEqual(r.body.aiCases);
    });

    it("reports only secrets as set or not set, and never their value", async () => {
        const r = await viewer("GET", `${API}/scanners`);
        expect(r.status).toBe(200);
        expect(r.body.settings).toMatchObject({ enabled: ["zap", "nuclei"], maxRequestsPerSecond: 5, zap: { configured: false, apiKeySet: false } });
        expect(JSON.stringify(r.body)).not.toMatch(/SECURITY_ZAP_API_KEY|apikey=|\bkey\b"\s*:\s*"[A-Za-z0-9]{8}/i);
        expect(r.body.profiles.map((p: { id: string }) => p.id)).toEqual(["passive", "conservative-active", "advanced"]);
        expect(r.body.profiles.find((p: { id: string }) => p.id === "advanced").never.join(" ")).toMatch(/delete|destroy/i);
    });

    it("describes each profile, and refuses to judge an environment nobody named", async () => {
        const none = await viewer("GET", `${API}/projects/${pA}/scanners`);
        expect(none.body.application).toBeNull();
        // Without an application there is no environment to judge against, so an intrusive profile is "ask again with one", not a yes.
        expect(none.body.profiles.find((p: { id: string }) => p.id === "passive")).toMatchObject({ allowedHere: true, problem: null, intrusive: false });
        expect(none.body.profiles.find((p: { id: string }) => p.id === "advanced")).toMatchObject({ allowedHere: null, requiresApproval: true, intrusive: true });
        expect(none.body.profiles.find((p: { id: string }) => p.id === "advanced").problem).toMatch(/approval recorded by an owner/);
        // Named: a staging application may be scanned actively, but not at the intrusive profile without an approval.
        const staging = await viewer("GET", `${API}/projects/${pA}/scanners?applicationId=${appId}`);
        expect(staging.body.application).toMatchObject({ id: appId, environment: "staging" });
        expect(staging.body.profiles.find((p: { id: string }) => p.id === "conservative-active")).toMatchObject({ allowedHere: true, problem: null });
        expect(staging.body.profiles.find((p: { id: string }) => p.id === "advanced")).toMatchObject({ allowedHere: false });
        expect(staging.body.profiles.find((p: { id: string }) => p.id === "advanced").problem).toMatch(/approval recorded by an owner/);
        // An application of another project is a 404, not another project's environment leaking through.
        expect((await viewer("GET", `${API}/projects/${pA}/scanners?applicationId=${appB}`)).status).toBe(404);
    });

    it("refuses a profile it does not know rather than quietly falling back", async () => {
        expect((await viewer("GET", `${API}/projects/${pA}/scanners?profile=nuclear`)).status).toBe(400);
        expect((await viewer("GET", `${API}/projects/${pA}/scanners?profile=nuclear`)).body.error).toMatch(/not a security scan profile/);
    });

    it("lets an editor allow scanners for this project, and records who did it", async () => {
        expect((await viewer("PUT", `${API}/projects/${pA}/scanners`, { enabled: ["zap"] })).status).toBe(403);
        const bad = await editor("PUT", `${API}/projects/${pA}/scanners`, { enabled: ["zap", "sqlmap"] });
        expect(bad.status).toBe(400);
        const r = await editor("PUT", `${API}/projects/${pA}/scanners`, { enabled: ["zap", "nuclei", "promptfoo"] });
        expect(r.status).toBe(200);
        // promptfoo was ticked but the platform never switched it on, so it is answered as refused rather than silently dropped.
        expect(r.body.allowed).toEqual(["zap", "nuclei"]);
        expect(r.body.refused).toEqual(["promptfoo"]);
        const audit = platform.db.all<{ action: string; summary: string; actor_name: string }>("SELECT action, summary, actor_name FROM security_audit WHERE action = 'scanners.changed' ORDER BY rowid DESC LIMIT 1");
        expect(audit[0]?.summary).toMatch(/: zap, nuclei\.$/);
        expect(audit[0]?.actor_name).toBeTruthy();
    });

    it("keeps a scanner off a project unless both gates are open, and says which one is shut", async () => {
        // Allowed for the project, but promptfoo was never named in SECURITY_SCANNERS.
        const r = await viewer("GET", `${API}/projects/${pA}/scanners`);
        expect(r.body.allowed).toEqual(["zap", "nuclei"]);
        expect(r.body.scanners.find((s: { id: string }) => s.id === "promptfoo")).toMatchObject({ status: "off" });
        expect(r.body.scanners.find((s: { id: string }) => s.id === "schemathesis")).toMatchObject({ status: "off" });
        // Both gates shut are two different sentences, and dropping one from the project's list is what makes the other visible.
        await editor("PUT", `${API}/projects/${pA}/scanners`, { enabled: ["nuclei"] });
        const oneGate = await viewer("GET", `${API}/projects/${pA}/scanners`);
        expect(oneGate.body.scanners.find((s: { id: string }) => s.id === "zap")).toMatchObject({ status: "not-allowed" });
        expect(oneGate.body.scanners.find((s: { id: string }) => s.id === "zap").reason).toMatch(/not allowed for this project/);
        await editor("PUT", `${API}/projects/${pA}/scanners`, { enabled: ["zap", "nuclei"] });
        const after = await viewer("GET", `${API}/projects/${pA}/scanners`);
        expect(after.body.scanners.find((s: { id: string }) => s.id === "nuclei").status).not.toBe("off");
        expect(after.body.scanners.find((s: { id: string }) => s.id === "nuclei").status).not.toBe("not-allowed");
        await editor("PUT", `${API}/projects/${pA}/scanners`, { enabled: [] });
        expect((await viewer("GET", `${API}/projects/${pA}/scanners`)).body.allowed).toEqual([]);
    });

    it("shows what the tools did, and admits the ones that did not run", async () => {
        const done = createRun(platform.db, { assessmentId, projectId: pA, applicationId: appId, scanner: "nuclei", profile: "passive", approval: null });
        updateRun(platform.db, done.id, { state: "COMPLETED", findingsCount: 2, reference: "nuclei-1", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), tookMs: 4000, coverage: { inspected: ["Nuclei looked at 12 addresses."], notInspected: ["Nuclei checks only the reviewed templates that are installed."] } });
        const failed = createRun(platform.db, { assessmentId, projectId: pA, applicationId: appId, scanner: "zap", profile: "passive", approval: null });
        updateRun(platform.db, failed.id, { state: "FAILED", findingsCount: 0, reference: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), tookMs: 900, coverage: { inspected: [], notInspected: ["ZAP did not answer."] } });
        const other = createRun(platform.db, { assessmentId: assessmentB, projectId: pB, applicationId: appB, scanner: "nuclei", profile: "passive", approval: null });

        const byAssessment = await viewer("GET", `${API}/assessments/${assessmentId}/scans`);
        expect(byAssessment.status).toBe(200);
        expect(byAssessment.body).toMatchObject({ assessmentId, profile: "passive" });
        expect(byAssessment.body.runs.map((r: { scanner: string }) => r.scanner).sort()).toEqual(["nuclei", "zap"]);
        const zapRun = byAssessment.body.runs.find((r: { scanner: string }) => r.scanner === "zap");
        expect(zapRun).toMatchObject({ state: "FAILED", findingsCount: 0, reference: null });
        expect(zapRun.coverage.notInspected).toEqual(["ZAP did not answer."]);

        const byProject = await viewer("GET", `${API}/projects/${pA}/scans`);
        expect(byProject.body.runs.every((r: { projectId: string }) => r.projectId === pA)).toBe(true);
        expect(byProject.body.runs.some((r: { id: string }) => r.id === other.id)).toBe(false);
        // Another project's list holds only its own run, and naming this project's assessment over there is a 404.
        expect((await viewer("GET", `${API}/projects/${pB}/scans`)).body.runs.map((r: { id: string }) => r.id)).toEqual([other.id]);
        expect((await viewer("GET", `${API}/assessments/${other.id}/scans?projectId=${pA}`)).status).toBe(404);
        expect((await viewer("GET", `${API}/assessments/no-such/scans`)).status).toBe(404);
    });

    it("never shows a ZAP API key in a run row", async () => {
        const r = await viewer("GET", `${API}/assessments/${assessmentId}/scans`);
        expect(JSON.stringify(r.body)).not.toMatch(/apikey|api_key/i);
    });
});

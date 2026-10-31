/**
 * Security Assessment findings and reports through the real platform server (server.inject, no port opened): filters, the finding
 * detail, validation with history, roles (viewer reads, editor validates and enters, an owner accepts a risk), manual entry, the
 * overview, HTML/CSV/PDF reports, the audit trail of exports, tenant isolation on every route, and no secret in any answer.
 *
 * The PDF is made by the platform's own Chromium, so run it under the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-findings-api.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { evaluateSecurity, type SecurityCall, type SecurityCheck } from "../src/engine/security/checks.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { UserStore } from "../src/platform/user-store.js";
import { fromCheckFailure, ingest, type RawResult } from "../src/security/findings/ingest.js";
import { securityStoreFor, type SecurityStore } from "../src/security/store.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "find-test-access-key-0123456789";
const API = "/api/v1/security";
const SENTINELS = { cookie: "FINDCOOKIE-SENTINEL-1a2b", env: "FINDENV-SENTINEL-3c4d", email: "client.person@find-sentinel.example", token: "FINDTOKEN-SENTINEL-5e6f" };

let dir: string;
let platform: Platform;
let app: App;
let store: SecurityStore;
let projectId: string;
let otherProjectId: string;
let editorToken: string;
let viewerToken: string;
let appId: string;
let otherAppId: string;
let firstId: string;
let retestId: string;
const answers: string[] = [];

async function call(method: string, url: string, body?: unknown, key = KEY) {
    const res = await app.inject({ method: method as "GET", url, headers: { "x-api-key": key, ...(body ? { "content-type": "application/json" } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    answers.push(res.body);
    let json: any;
    try {
        json = res.json();
    } catch {
        json = undefined;
    }
    return { status: res.statusCode, body: json, raw: res.rawPayload, headers: res.headers, text: res.body };
}

const page = (url: string, over: Partial<SecurityCall> = {}): SecurityCall => ({ status: 200, headers: { "content-type": "text/html", server: "Apache/2.4.7" }, text: "<html></html>", url, ...over });
async function results(check: SecurityCheck, c: SecurityCall): Promise<RawResult[]> {
    const msg = await evaluateSecurity(check, [c]);
    return msg ? fromCheckFailure(check, msg, c) : [];
}

/** An assessment that is already finished (so no assessment loop picks it up), with these results ingested. */
async function finishedAssessment(application: string, rs: RawResult[], retestOf?: string) {
    const a0 = store.getApplication(application)!;
    const auth = store.currentAuthorization(a0)!;
    const a = store.createAssessment({ applicationId: application, authorizationId: auth.id, startedBy: "Test", retestOf });
    store.updateAssessment(a.id, { state: "COMPLETED", progress: 100, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), coverage: { pagesSeen: 2, formsSeen: 1, apiCallsSeen: 0, notInspected: ["Signed-in pages: no account was given."] } });
    await ingest(store, store.getAssessment(a.id)!, rs);
    return a.id;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secfind-api-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", SECRET_KEY: "find-test-secret-key-0123456789", API_KEY: KEY }));
    app = await buildServer(platform);
    await app.ready();
    store = securityStoreFor(platform.db);
    projectId = String(platform.repo.createProject({ name: "Client A" }).id);
    otherProjectId = String(platform.repo.createProject({ name: "Client B" }).id);
    const users = new UserStore(platform.db);
    editorToken = users.createToken(users.create({ email: "ed@example.com", name: "Ed", role: "editor" }).id, { name: "t", role: "editor" }).token;
    viewerToken = users.createToken(users.create({ email: "vi@example.com", name: "Vi", role: "viewer" }).id, { name: "t", role: "viewer" }).token;

    const mk = (pid: string, name: string) => {
        const a = store.createApplication(pid, { name, targetUrl: "http://shop.test/", environment: "staging", excludedPaths: ["/admin"] });
        store.addAuthorization(a.id, { basis: "client-permission", approverName: "Pat Approver", approverEmail: SENTINELS.email, documentReference: "SOW-7", restrictions: "Office hours only", statement: "I confirm.", confirmedByName: "Owner" });
        return a.id;
    };
    appId = mk(projectId, "Shop");
    otherAppId = mk(otherProjectId, "Other shop");
    const shared = [
        ...(await results("securityHeaders", page("http://shop.test/"))),
        ...(await results("cookieFlags", page("http://shop.test/login", { setCookies: [`session=${SENTINELS.cookie}; Path=/`] }))),
        ...(await results("noInfoDisclosure", page("http://shop.test/"))),
    ];
    const env = await results("noExposedFiles", page("http://shop.test/.env", { headers: { "content-type": "text/plain" }, text: `DB_PASSWORD=${SENTINELS.env}\nMAIL=${SENTINELS.email}\n` }));
    firstId = await finishedAssessment(appId, [...shared, ...env]);
    await finishedAssessment(otherAppId, shared);
    // The retest no longer sees the .env file.
    retestId = await finishedAssessment(appId, shared, firstId);
});

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("findings", () => {
    it("lists with filters, and keeps each project to itself", async () => {
        const all = await call("GET", `${API}/projects/${projectId}/findings`);
        expect(all.status).toBe(200);
        expect(all.body.total).toBe(7); // 4 headers, cookie, server banner, .env
        expect(all.body.findings[0].severity).toBe("critical");
        const env = (await call("GET", `${API}/projects/${projectId}/findings?category=exposed-files`)).body;
        expect(env.findings).toHaveLength(1);
        expect(env.findings[0].validation).toBe("fixed");
        expect((await call("GET", `${API}/projects/${projectId}/findings?severity=low,medium&validation=probable`)).body.total).toBe(6);
        expect((await call("GET", `${API}/projects/${projectId}/findings?q=cookie`)).body.total).toBe(1);
        expect((await call("GET", `${API}/projects/${projectId}/findings?location=.env`)).body.total).toBe(1);
        expect((await call("GET", `${API}/projects/${projectId}/findings?to=2000-01-01`)).body.total).toBe(0);
        expect((await call("GET", `${API}/projects/${projectId}/findings?application=${appId}`, undefined, viewerToken)).body.total).toBe(7);
        const bad = await call("GET", `${API}/projects/${projectId}/findings?severity=urgent`);
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/Unknown severity/);
        expect((await call("GET", `${API}/projects/${projectId}/findings?application=${otherAppId}`)).status).toBe(404);
        expect((await call("GET", `${API}/projects/nope/findings`)).status).toBe(404);
    });

    it("shows one finding with its history and the assessments that saw it; another project's id answers 404", async () => {
        const f = (await call("GET", `${API}/projects/${projectId}/findings?category=exposed-files`)).body.findings[0];
        const d = await call("GET", `${API}/findings/${f.id}`, undefined, viewerToken);
        expect(d.status).toBe(200);
        expect(d.body.application).toMatchObject({ id: appId, name: "Shop" });
        expect(d.body.history.map((h: { to: string | null }) => h.to)).toContain("fixed");
        expect(d.body.sightings.map((s: { assessmentId: string }) => s.assessmentId)).toEqual([firstId]);
        expect(d.body.finding.reproduction).toMatch(/private browser window/);
        expect((await call("GET", `${API}/findings/${f.id}?projectId=${otherProjectId}`)).status).toBe(404);
        expect((await call("GET", `${API}/findings/nope`)).status).toBe(404);
    });

    it("validation: viewers cannot, editors can with history, false positive needs a reason, accepting a risk needs an owner", async () => {
        const f = (await call("GET", `${API}/projects/${projectId}/findings?q=Content-Security-Policy`)).body.findings[0];
        expect((await call("PATCH", `${API}/findings/${f.id}`, { validation: "confirmed" }, viewerToken)).status).toBe(403);
        const ok = await call("PATCH", `${API}/findings/${f.id}`, { validation: "confirmed", comment: `Seen by ${SENTINELS.email}` }, editorToken);
        expect(ok.status).toBe(200);
        expect(ok.body.finding.validation).toBe("confirmed");
        expect(ok.body.history.at(-1)).toMatchObject({ from: "probable", to: "confirmed", comment: "Seen by [email hidden]" });
        expect(ok.body.history.at(-1).actor).toMatch(/^Ed/);
        const noReason = await call("PATCH", `${API}/findings/${f.id}`, { validation: "false-positive" }, editorToken);
        expect(noReason.status).toBe(400);
        expect(noReason.body.error).toMatch(/add a comment/);
        expect((await call("PATCH", `${API}/findings/${f.id}`, { validation: "accepted-risk", comment: "Business decision" }, editorToken)).status).toBe(403);
        expect((await call("PATCH", `${API}/findings/${f.id}`, { validation: "accepted-risk", comment: "Business decision" })).body.finding.validation).toBe("accepted-risk");
        expect((await call("PATCH", `${API}/findings/${f.id}`, { validation: "bogus" })).status).toBe(400);
        expect((await call("PATCH", `${API}/findings/${f.id}?projectId=${otherProjectId}`, { validation: "probable" }, editorToken)).status).toBe(404);
        expect((await call("PATCH", `${API}/findings/nope`, { validation: "probable" }, editorToken)).status).toBe(404);
        const trail = (await call("GET", `${API}/projects/${projectId}/activity`)).body.events as Array<{ action: string }>;
        expect(trail.filter((e) => e.action === "finding.validation-changed").length).toBe(2);
    });

    it("manual entry: editor only, redacted, of this project's application only", async () => {
        const body = {
            title: "Outdated jQuery (client scanner)",
            category: "configuration",
            severity: "medium",
            location: `http://shop.test/assets/app.js?token=${SENTINELS.token}`,
            description: `Reported by ${SENTINELS.email}`,
            impact: "Known weaknesses in the library.",
            remediation: "Update jQuery.",
            evidence: [{ kind: "note", label: "Scanner", value: `Authorization: Bearer ${SENTINELS.token}` }],
        };
        expect((await call("POST", `${API}/applications/${appId}/findings`, body, viewerToken)).status).toBe(403);
        const made = await call("POST", `${API}/applications/${appId}/findings`, body, editorToken);
        expect(made.status).toBe(201);
        expect(made.body.finding).toMatchObject({ source: "manual", validation: "needs-review", location: "http://shop.test/assets/app.js" });
        expect(made.text).not.toContain(SENTINELS.token);
        expect(made.text).not.toContain(SENTINELS.email);
        expect((await call("POST", `${API}/applications/${appId}/findings?projectId=${otherProjectId}`, body, editorToken)).status).toBe(404);
        expect((await call("POST", `${API}/applications/${appId}/findings`, { ...body, severity: "huge" }, editorToken)).status).toBe(400);
        expect((await call("POST", `${API}/applications/${appId}/findings`, { ...body, validation: "accepted-risk", comment: "x" }, editorToken)).status).toBe(403);
    });

    it("overview: the numbers and the written risk rules", async () => {
        const o = await call("GET", `${API}/projects/${projectId}/overview`, undefined, viewerToken);
        expect(o.status).toBe(200);
        expect(o.body.counts).toMatchObject({ applications: 1, applicationsAssessed: 1, assessmentsCompleted: 2, fixedAfterRetest: 1, openCriticalHigh: 0 });
        expect(o.body.counts.remediationRemaining).toBe(o.body.counts.awaitingReview);
        expect(o.body.risk.level).toBe("medium");
        expect(o.body.risk.rules.join(" ")).toMatch(/never|not a statement that the application is secure/);
        expect(o.body.fixedRecently[0]).toMatchObject({ retestId });
        expect(o.body.applications[0].lastAssessment.id).toBe(retestId);
        // The other project sees only its own application and findings.
        const other = (await call("GET", `${API}/projects/${otherProjectId}/overview`)).body;
        expect(other.applications.map((a: { id: string }) => a.id)).toEqual([otherAppId]);
        expect(other.counts.fixedAfterRetest).toBe(0);
        expect((await call("GET", `${API}/projects/nope/overview`)).status).toBe(404);
        expect((await call("GET", `${API}/projects/nope/report`)).status).toBe(404);
    });
});

describe("reports", () => {
    it("HTML: every section, the retest, locked down, and audited", async () => {
        const r = await call("GET", `${API}/assessments/${retestId}/report`, undefined, viewerToken);
        expect(r.status).toBe(200);
        expect(r.headers["content-type"]).toMatch(/text\/html/);
        expect(r.headers["content-security-policy"]).toMatch(/default-src 'none'/);
        for (const h of ["Executive summary", "Scope and authorization", "Risk overview", "Findings by category", "Top issues", "Affected locations", "Retest results", "Coverage and limitations", "Configuration and timestamps"]) expect(r.text).toContain(`<h2>${h}`);
        expect(r.text).toContain("Pat Approver");
        expect(r.text).toContain("Office hours only");
        expect(r.text).toContain("Signed-in pages: no account was given.");
        expect(r.text).toMatch(/Fixed \(not seen again\): 1/);
        const trail = (await call("GET", `${API}/projects/${projectId}/activity`)).body.events as Array<{ action: string; summary: string }>;
        expect(trail.find((e) => e.action === "report.exported")!.summary).toMatch(/as HTML/);
        expect((await call("GET", `${API}/assessments/${retestId}/report?projectId=${otherProjectId}`)).status).toBe(404);
    });

    it("CSV opens in Excel and lists every finding of the project", async () => {
        const r = await call("GET", `${API}/projects/${projectId}/report?format=csv`, undefined, viewerToken);
        expect(r.status).toBe(200);
        expect(r.headers["content-disposition"]).toMatch(/attachment; filename="security-report-client-a-\d{4}-\d{2}-\d{2}\.csv"/);
        const text = r.raw.toString("utf8");
        expect(text.charCodeAt(0)).toBe(0xfeff);
        const lines = text.split("\r\n").filter(Boolean);
        expect(lines[0]).toMatch(/^﻿"Id","Application","Title","Severity"/);
        expect(lines.length).toBeGreaterThan(8);
        expect((await call("GET", `${API}/projects/${projectId}/report?format=doc`)).status).toBe(400);
    });

    it("PDF is made by the platform's Chromium", async () => {
        const r = await call("GET", `${API}/assessments/${firstId}/report?format=pdf`, undefined, viewerToken);
        expect(r.status).toBe(200);
        expect(r.headers["content-type"]).toBe("application/pdf");
        expect(r.raw.subarray(0, 5).toString()).toBe("%PDF-");
        for (const s of Object.values(SENTINELS)) expect(r.raw.includes(Buffer.from(s))).toBe(false);
    }, 120_000);

    it("no secret reached any answer or the activity list", async () => {
        const activity = JSON.stringify(platform.db.all("SELECT * FROM activity"));
        for (const s of Object.values(SENTINELS)) {
            for (const a of answers) expect(a).not.toContain(s);
            expect(activity).not.toContain(s);
        }
    });
});

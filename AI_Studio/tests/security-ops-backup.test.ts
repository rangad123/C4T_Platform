/**
 * Security Assessment data in backups (src/security/backup.ts, hooked into src/platform/backup.ts), through the real platform server
 * (Fastify inject, no network, no browser).
 *
 * Proves: the scheduled full backup (BACKUP_DIR) holds the security tables; a project backup carries applications (sensitive workflows,
 * the saved sign-in's name, the API document), authorizations, assessments with the retest link, findings with history and sightings,
 * the trail and the message setting, with redaction intact and no secret (a bearer token typed into a manual finding, an alert channel's
 * address, the saved sign-in itself); a restore makes a new project where nothing is authorized or running (authorizations withdrawn, an
 * unfinished assessment cancelled), ids are new, the trail says it was restored, and a hand-edited file is redacted again or refused as
 * damaged with nothing created; a functional-only project's backup has no security.json.
 * Also (the newer security tables): the authorization's profile, cross-account accounts, role and authority, Crowd4Test admin profile
 * approvals, schedules and cross-account designations round-trip with new ids; a restored approval never counts (withdrawn, no approver
 * id, no details fingerprint); a restored schedule is switched off with no next run; the test accounts are listed as sign-ins to enter
 * again; a backup made before these fields restores as before.
 *
 * No ports (inject only). Run under the lock (it starts the platform server):
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ops-backup.test.ts
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DOCUMENTS } from "../src/engine/retention/backup-model.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { makeBackup } from "../src/platform/ops/backup-schedule.js";
import { addTest, type Seed } from "./fixtures/retention-seed.js";
import { buildServer } from "../src/platform/server.js";
import { saveApiDocument } from "../src/security/extras.js";
import { securityStoreFor, type SecurityStore } from "../src/security/store.js";
import { readDesignation, writeDesignation } from "../src/security/cross-account-store.js";
import { addApproval, currentApproval, listApprovals } from "../src/security/profile-gate.js";
import { SecurityScheduleStore } from "../src/security/schedules.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const KEY = "sec-ops-backup-key-0123456789";
const API = "/api/v1/security";
const BEARER = "Bearer QmVhcmVyLVNFTlRJTkVMLTcxNzAtdG9rZW4";
const HOOK_TOKEN = "HOOK-TOKEN-SENTINEL-7170";
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-backup-"));
    dirs.push(d);
    return d;
};

describe("security assessment data in backups", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let store: SecurityStore;
    let pid: string;
    let appId: string;
    let functionalPid: string;
    const ids: Record<string, string> = {};

    const call = async (method: string, url: string, body?: unknown) => {
        const isBuffer = Buffer.isBuffer(body) || body instanceof Uint8Array;
        const r = await app.inject({
            method: method as never,
            url,
            headers: { "x-api-key": KEY, ...(body === undefined ? {} : { "content-type": isBuffer ? "application/octet-stream" : "application/json" }) },
            ...(body === undefined ? {} : { payload: isBuffer ? Buffer.from(body as Uint8Array) : JSON.stringify(body) }),
        });
        const text = r.rawPayload.toString("utf8");
        return { status: r.statusCode, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, raw: r.rawPayload };
    };

    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY }));
        app = await buildServer(platform);
        await app.ready();
        store = securityStoreFor(platform.db);
        pid = (await call("POST", "/api/projects", { name: "Client A" })).body.id;
        functionalPid = (await call("POST", "/api/projects", { name: "Functional only" })).body.id;
        expect((await call("PUT", `${API}/projects/${pid}/testing-type`, { testingType: "both" })).status).toBe(200);

        const a = store.createApplication(pid, {
            name: "Shop",
            targetUrl: "https://shop.example.com/",
            environment: "staging",
            scope: ["https://api.example.com"],
            excludedPaths: ["/admin"],
            maxRequestsPerSecond: 3,
            notes: "Main site",
            signInAccount: "main",
            sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/checkout/pay"], note: "Never touch" }],
        } as never);
        appId = a.id;
        saveApiDocument(platform.db, a.id, { fileName: "openapi.json", format: "json", sizeBytes: 60, sha256: "x", title: "Shop API", version: "1.0", operations: 3, requestable: 1, uploadedBy: "Olga", content: '{"openapi":"3.0.0","info":{"title":"Shop API","version":"1.0"},"paths":{}}' });
        const auth = store.addAuthorization(a.id, { basis: "client-permission", approverName: "Dana Client", approverEmail: "dana@client.example", documentReference: "SOW-12", restrictions: "Weekdays only", statement: "I confirm that Client A …", confirmedByUserId: "u1", confirmedByName: "Olga" });
        ids.auth = auth.id;
        const first = store.createAssessment({ applicationId: a.id, authorizationId: auth.id, startedBy: "Olga" });
        ids.first = first.id;
        const ev = [{ kind: "cookie" as const, label: "sid", value: "sid=[hidden]; Path=/", observedAt: "2026-10-01T10:00:00.000Z" }];
        const f1 = store.upsertFinding({ projectId: pid, applicationId: a.id, assessmentId: first.id, fingerprint: "cookies:secure:https://shop.example.com", checkId: "cookie-flags", title: "Session cookie without Secure", category: "cookies", severity: "high", confidence: "high", location: "https://shop.example.com/", description: "d", impact: "i", remediation: "r", evidence: ev, source: "built-in", initialValidation: "probable" }).finding;
        ids.f1 = f1.id;
        store.upsertFinding({ projectId: pid, applicationId: a.id, assessmentId: first.id, fingerprint: "headers:csp:https://shop.example.com", title: "No CSP", category: "headers", severity: "medium", confidence: "high", location: "https://shop.example.com/", description: "d", impact: "i", remediation: "r", evidence: [], source: "built-in" });
        store.setValidation(f1.id, "confirmed", { comment: "Seen in the browser too." });
        store.updateAssessment(first.id, { state: "COMPLETED", finishedAt: "2026-10-01T10:05:00.000Z", coverage: { pagesSeen: 4, formsSeen: 1, apiCallsSeen: 2, notInspected: ["Signed-in areas …"] } });
        const retest = store.createAssessment({ applicationId: a.id, authorizationId: auth.id, startedBy: "Olga", retestOf: first.id });
        ids.retest = retest.id;
        store.recordSighting(f1.id, retest.id, ev);
        store.addFindingNote(f1.id, "Still present in the retest.", retest.id);
        store.updateAssessment(retest.id, { state: "COMPLETED", finishedAt: "2026-10-02T10:05:00.000Z" });
        const running = store.createAssessment({ applicationId: a.id, authorizationId: auth.id, startedBy: "Olga" });
        store.updateAssessment(running.id, { state: "SCANNING", progress: 60 });
        ids.running = running.id;

        // A manual finding with a credential typed into its evidence: stored redacted (FIND), so the backup never sees it.
        const manual = await call("POST", `${API}/applications/${a.id}/findings`, {
            title: "Token in a page",
            category: "information-disclosure",
            severity: "critical",
            location: "https://shop.example.com/debug",
            description: "The debug page shows a token.",
            impact: "Anyone can use it.",
            remediation: "Remove the page.",
            evidence: [{ kind: "body-excerpt", label: "page", value: `Authorization: ${BEARER}` }],
        });
        expect(manual.status).toBe(201);
        expect(JSON.stringify(manual.body)).not.toContain(BEARER.slice(7));

        const hook = await call("POST", `/api/projects/${pid}/alert-channels`, { kind: "webhook", name: "Security room", url: `https://hooks.example.com/${HOOK_TOKEN}` });
        expect(hook.status).toBe(201);
        expect((await call("PUT", `${API}/projects/${pid}/notifications`, { everyFinish: true, channelIds: [hook.body.id] })).status).toBe(200);
    }, 60_000);
    afterAll(async () => {
        await app?.close();
        platform?.db.close();
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    });

    it("the scheduled full backup holds the security tables", async () => {
        const dir = tmp();
        const out = await makeBackup({ db: platform.db, dataDir: platform.config.dataDir, secretKeyFromEnv: false, dir, keep: 3, log: () => undefined });
        expect(out.ok).toBe(true);
        const copy = new sqlite.DatabaseSync(path.join(dir, out.file!), { readOnly: true });
        try {
            const n = (sql: string) => Number((copy.prepare(sql).get(pid) as { n: number }).n);
            expect(n("SELECT COUNT(*) AS n FROM security_applications WHERE project_id = ?")).toBe(1);
            expect(n("SELECT COUNT(*) AS n FROM security_authorizations WHERE application_id IN (SELECT id FROM security_applications WHERE project_id = ?)")).toBe(1);
            expect(n("SELECT COUNT(*) AS n FROM security_assessments WHERE project_id = ?")).toBe(3);
            expect(n("SELECT COUNT(*) AS n FROM security_findings WHERE project_id = ?")).toBe(3);
            expect(n("SELECT COUNT(*) AS n FROM security_finding_history WHERE finding_id IN (SELECT id FROM security_findings WHERE project_id = ?)")).toBeGreaterThanOrEqual(2);
            expect(n("SELECT COUNT(*) AS n FROM security_finding_sightings WHERE finding_id IN (SELECT id FROM security_findings WHERE project_id = ?)")).toBe(3);
            expect(n("SELECT COUNT(*) AS n FROM security_audit WHERE project_id = ?")).toBeGreaterThanOrEqual(3);
            expect(n("SELECT COUNT(*) AS n FROM security_project_settings WHERE project_id = ?")).toBe(1);
            expect(n("SELECT COUNT(*) AS n FROM security_application_extras WHERE application_id IN (SELECT id FROM security_applications WHERE project_id = ?)")).toBe(1);
            expect(n("SELECT COUNT(*) AS n FROM security_api_documents WHERE application_id IN (SELECT id FROM security_applications WHERE project_id = ?)")).toBe(1);
            expect(Number((copy.prepare("SELECT COUNT(*) AS n FROM ai_settings WHERE key = ?").get(`security-notify:${pid}`) as { n: number }).n)).toBe(1);
        } finally {
            copy.close();
        }
    });

    let zip: Uint8Array;
    let docText: string;
    it("a project backup carries the security data, redacted, without secrets", async () => {
        const r = await call("GET", `/api/projects/${pid}/backup`);
        expect(r.status).toBe(200);
        zip = new Uint8Array(r.raw);
        const files = unzipSync(zip);
        expect(Object.keys(files)).toContain("security.json");
        docText = strFromU8(files["security.json"]!);
        const doc = JSON.parse(docText);
        expect(doc).toMatchObject({ format: 1, testingType: "both", notifications: { newCriticalHigh: true, failed: true, everyFinish: true, channelsChosen: true } });
        expect(doc.applications).toHaveLength(1);
        expect(doc.applications[0]).toMatchObject({
            ref: "app-1",
            name: "Shop",
            targetUrl: "https://shop.example.com/",
            scope: ["https://api.example.com"],
            excludedPaths: ["/admin"],
            maxRequestsPerSecond: 3,
            signInAccount: "main",
            sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/checkout/pay"], note: "Never touch" }],
            apiDocument: { fileName: "openapi.json", title: "Shop API", operations: 3 },
        });
        expect(doc.authorizations).toEqual([expect.objectContaining({ applicationRef: "app-1", basis: "client-permission", approverName: "Dana Client", documentReference: "SOW-12", restrictions: "Weekdays only", statement: "I confirm that Client A …", confirmedByName: "Olga", revokedAt: null })]);
        expect(doc.assessments.map((a: any) => a.state).sort()).toEqual(["COMPLETED", "COMPLETED", "SCANNING"]);
        const retest = doc.assessments.find((a: any) => a.retestOfRef);
        expect(doc.assessments.find((a: any) => a.ref === retest.retestOfRef).coverage).toMatchObject({ pagesSeen: 4 });
        const f1 = doc.findings.find((f: any) => f.title === "Session cookie without Secure");
        expect(f1).toMatchObject({ validation: "confirmed", severity: "high", checkId: "cookie-flags" });
        expect(f1.history.map((h: any) => [h.from, h.to, h.comment])).toEqual([
            ["probable", "confirmed", "Seen in the browser too."],
            [null, null, "Still present in the retest."],
        ]);
        expect(f1.sightings).toHaveLength(2);
        expect(doc.audit.map((e: any) => e.action)).toEqual(expect.arrayContaining(["testing-type.changed", "finding.created", "notifications.changed"]));
        // Redaction intact, no secret anywhere in the zip (the token, the alert channel's address, the saved sign-in's state).
        const everything = Object.values(files).map((b) => strFromU8(b)).join("\n");
        expect(everything).not.toContain(BEARER.slice(7));
        expect(everything).not.toContain(HOOK_TOKEN);
        expect(docText).toContain("[hidden]");
        // The saved sign-in is named as something to enter again; the manifest counts the security parts.
        const needs = JSON.parse(strFromU8(files["secrets-needed.json"]!));
        expect(needs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "application-sign-in", label: "Saved sign-in “main” for the security assessment of “Shop”" })]));
        const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
        expect(manifest.counts).toMatchObject({ securityApplications: 1, securityAuthorizations: 1, securityAssessments: 3, securityFindings: 3 });
    });

    it("a functional-only project's backup has no security part", async () => {
        const files = unzipSync(new Uint8Array((await call("GET", `/api/projects/${functionalPid}/backup`)).raw));
        expect(Object.keys(files)).not.toContain("security.json");
        expect(JSON.parse(strFromU8(files["manifest.json"]!)).counts.securityApplications).toBeUndefined();
    });

    it("restores into a new project where nothing is authorized or running, with the history and the trail", async () => {
        const r = await call("POST", "/api/projects/restore?name=Client%20A%20copy", zip);
        expect(r.status).toBe(201);
        // Round 21: a project with security data and no tests says what came back, not "Restored 0 tests".
        expect(r.body.message).toMatch(
            /^Restored the security assessment data into a new project, “Client A copy”: 1 application, 1 authorization \(withdrawn: record a new one before the next assessment\), 3 assessments and 3 findings\. Nothing has been run\./,
        );
        expect(r.body.message).not.toMatch(/0 tests/);
        const np = r.body.project.id as string;
        expect(np).not.toBe(pid);
        expect(r.body.restored).toMatchObject({ securityApplications: 1, securityAuthorizations: 1, securityAssessments: 3, securityFindings: 3, securitySightings: 3 });
        expect(r.body.notes.join(" ")).toMatch(/authorizations were restored as history and withdrawn/);
        expect(r.body.notes.join(" ")).toMatch(/1 security assessment had not finished/);
        expect(r.body.notes.join(" ")).toMatch(/Alert channels are not in a backup/);

        expect((await call("GET", `${API}/projects/${np}/testing-type`)).body.testingType).toBe("both");
        const apps = (await call("GET", `${API}/projects/${np}/applications`)).body.applications;
        expect(apps).toHaveLength(1);
        const na = apps[0];
        expect(na.id).not.toBe(appId);
        expect(na).toMatchObject({ name: "Shop", targetUrl: "https://shop.example.com/", signInAccount: "main", sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/checkout/pay"], note: "Never touch" }] });
        expect(na.apiDocument).toMatchObject({ fileName: "openapi.json", title: "Shop API" });
        expect(na.authorization.state).not.toBe("current");
        // Starting an assessment needs a new authorization.
        expect((await call("POST", `${API}/applications/${na.id}/assessments`, {})).status).toBe(409);
        const auths = (await call("GET", `${API}/applications/${na.id}/authorizations`)).body.authorizations;
        expect(auths).toHaveLength(1);
        expect(auths[0]).toMatchObject({ approverName: "Dana Client", confirmedByName: "Olga", confirmedByUserId: null, revokedReason: "Restored from a backup: record a new authorization before the next assessment." });

        const assessments = (await call("GET", `${API}/projects/${np}/assessments`)).body.assessments;
        expect(assessments.map((a: any) => a.state).sort()).toEqual(["CANCELLED", "COMPLETED", "COMPLETED"]);
        expect(assessments.find((a: any) => a.state === "CANCELLED").progressText).toBe("Restored from a backup before it had finished; it was not run again.");
        const retest = assessments.find((a: any) => a.retestOf);
        expect(assessments.some((a: any) => a.id === retest.retestOf)).toBe(true);
        expect(assessments.every((a: any) => ![ids.first, ids.retest, ids.running].includes(a.id))).toBe(true);
        expect(store.activeAssessments(np)).toEqual([]);

        const list = (await call("GET", `${API}/projects/${np}/findings`)).body.findings;
        expect(list).toHaveLength(3);
        const f1 = list.find((f: any) => f.title === "Session cookie without Secure");
        const detail = (await call("GET", `${API}/findings/${f1.id}`)).body;
        expect(detail.finding.validation).toBe("confirmed");
        expect(detail.history.map((h: any) => h.comment)).toEqual(["Seen in the browser too.", "Still present in the retest."]);
        expect(detail.sightings).toHaveLength(2);
        expect(JSON.stringify((await call("GET", `${API}/projects/${np}/findings`)).body)).not.toContain(BEARER.slice(7));

        const trail = (await call("GET", `${API}/projects/${np}/activity?limit=200`)).body.events;
        expect(trail[0]).toMatchObject({ action: "project.restored", objectId: np });
        expect(trail.map((e: any) => e.action)).toEqual(expect.arrayContaining(["testing-type.changed", "finding.created", "notifications.changed"]));
        expect(trail.every((e: any) => e.projectId === np)).toBe(true);

        const notify = (await call("GET", `${API}/projects/${np}/notifications`)).body;
        expect(notify.settings).toEqual({ newCriticalHigh: true, failed: true, everyFinish: true, channelIds: null });
        // The original is untouched.
        expect(store.authorizationState(store.getApplication(appId)!).state).toBe("current");
    });

    it("a hand-edited file is redacted again on restore; a damaged one is refused and creates nothing", async () => {
        const files = unzipSync(zip);
        const doc = JSON.parse(docText);
        doc.findings[0].evidence = [{ kind: "note", label: "pasted", value: `token ${BEARER} and jane.doe@client.example`, observedAt: "2026-10-01T00:00:00.000Z" }];
        doc.findings[0].description = `See ${BEARER}`;
        const edited = zipSync({ ...files, "security.json": strToU8(JSON.stringify(doc)) });
        const r = await call("POST", "/api/projects/restore?name=Edited", edited);
        expect(r.status).toBe(201);
        const rows = platform.db.all<{ evidence_json: string; description: string }>("SELECT evidence_json, description FROM security_findings WHERE project_id = ?", r.body.project.id);
        const stored = JSON.stringify(rows);
        expect(stored).not.toContain(BEARER.slice(7));
        expect(stored).not.toContain("jane.doe@client.example");
        expect(stored).toContain("[hidden]");

        const projectsBefore = platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n;
        const auditBefore = platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_audit")!.n;
        const broken = JSON.parse(docText);
        broken.assessments[0].applicationRef = "app-99";
        const bad = await call("POST", "/api/projects/restore", zipSync({ ...files, "security.json": strToU8(JSON.stringify(broken)) }));
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe("The backup is damaged: security.json: an assessment refers to something that is not in the backup.");
        const wrongShape = JSON.parse(docText);
        wrongShape.findings[0].severity = "catastrophic";
        const bad2 = await call("POST", "/api/projects/restore", zipSync({ ...files, "security.json": strToU8(JSON.stringify(wrongShape)) }));
        expect(bad2.status).toBe(400);
        expect(bad2.body.error).toMatch(/^The backup is damaged: security\.json \(findings\.0\.severity\)/);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n).toBe(projectsBefore);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_audit")!.n).toBe(auditBefore);
    });

    // ── round 21 (FX-S) ──
    it("a project with tests keeps the restore wording, plus a line for the security data", async () => {
        addTest(platform, { projectId: pid } as Seed);
        const full = await call("GET", `/api/projects/${pid}/backup`);
        const r = await call("POST", "/api/projects/restore?name=With%20tests", new Uint8Array(full.raw));
        expect(r.status).toBe(201);
        expect(r.body.message).toMatch(
            /^Restored 1 test into a new project, “With tests”\. Nothing has been run: the tests are waiting for you to run them\. Security assessment data: 1 application, 1 authorization \(withdrawn: record a new one before the next assessment\), 3 assessments and 3 findings\./,
        );
        // A project without security data: exactly today's sentence.
        const plain = await call("POST", "/api/projects/restore?name=Plain", new Uint8Array((await call("GET", `/api/projects/${functionalPid}/backup`)).raw));
        expect(plain.body.message).toBe("Restored 0 tests into a new project, “Plain”. Nothing has been run: the tests are waiting for you to run them.");
    });

    it("a backup without the security data (owner only, recorded) is the format of a platform from before round 20", async () => {
        expect((await call("GET", `/api/projects/${pid}/storage`)).body.securityData).toBe(true);
        expect((await call("GET", `/api/projects/${functionalPid}/storage`)).body.securityData).toBe(false);
        const full = unzipSync(new Uint8Array((await call("GET", `/api/projects/${pid}/backup`)).raw));
        const r = await call("GET", `/api/projects/${pid}/backup?withoutSecurity=true`);
        expect(r.status).toBe(200);
        const files = unzipSync(new Uint8Array(r.raw));
        // Only documents a platform from before round 20 knew (its list was today's without security.json); everything else unchanged.
        const before20 = DOCUMENTS.filter((d) => d !== "security.json");
        expect(Object.keys(files).sort()).toEqual(Object.keys(full).filter((k) => k !== "security.json").sort());
        for (const name of Object.keys(files)) expect(before20 as readonly string[], name).toContain(name);
        for (const name of ["tests.json", "project.json", "alert-channels.json"]) expect(strFromU8(files[name]!), name).toBe(strFromU8(full[name]!));
        const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
        expect(manifest.format).toBe(1);
        expect(Object.keys(manifest.counts).filter((k) => k.startsWith("security"))).toEqual([]);
        expect(manifest.counts.tests).toBe(1);
        const needs = JSON.parse(strFromU8(files["secrets-needed.json"]!)) as Array<{ label: string }>;
        expect(needs.some((n) => /security assessment/.test(n.label))).toBe(false);
        expect(needs.some((n) => /Security room/.test(n.label))).toBe(true);

        // Recorded in the security trail and in Activity, with what was left out.
        const trail = (await call("GET", `${API}/projects/${pid}/activity`)).body.events;
        expect(trail[0]).toMatchObject({ action: "project.backup-without-security", summary: "Downloaded a project backup without the security assessment data, for an older platform: 1 application, 1 authorization, 3 assessments and 3 findings were left out of it." });
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE project_id = ? AND action = 'security:project.backup-without-security'", pid)!.n).toBe(1);

        // Restored here it brings the tests and no security data.
        const back = await call("POST", "/api/projects/restore?name=Older%20format", new Uint8Array(r.raw));
        expect(back.status).toBe(201);
        expect(back.body.message).toMatch(/^Restored 1 test into a new project, “Older format”\./);
        expect(back.body.message).not.toMatch(/Security assessment data/);
        expect(back.body.restored.securityApplications).toBeUndefined();
        expect((await call("GET", `${API}/projects/${back.body.project.id}/applications`)).body.applications).toEqual([]);

        // A project without security data: the same file as always; only an Activity line (a trail line would itself be security data).
        const f = unzipSync(new Uint8Array((await call("GET", `/api/projects/${functionalPid}/backup?withoutSecurity=true`)).raw));
        expect(Object.keys(f)).not.toContain("security.json");
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_audit WHERE project_id = ?", functionalPid)!.n).toBe(0);
        expect(platform.db.get<{ detail: string }>("SELECT detail FROM activity WHERE project_id = ? AND action = 'security:project.backup-without-security'", functionalPid)!.detail).toMatch(/the project has none, so nothing was left out/);
        expect((await call("GET", `/api/projects/${functionalPid}/storage`)).body.securityData).toBe(false);

        // Owner only, like every backup.
        const users = accessControlOf(app).users;
        const ed = users.create({ email: "ed@example.com", name: "Ed", role: "editor" });
        const token = users.createToken(ed.id, { name: "t", role: "editor" }).token;
        const refused = await app.inject({ method: "GET", url: `/api/projects/${pid}/backup?withoutSecurity=true`, headers: { "x-api-key": token } });
        expect(refused.statusCode).toBe(403);
    });
});

describe("the newer security tables in backups (profile approvals, schedules, cross-account designations)", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let store: SecurityStore;
    let pid: string;
    let appId: string;
    let zip: Uint8Array;
    const designation = { accountA: "alice", accountB: "bob", resources: [{ path: "/api/notes/42", kind: "item" as const, owner: "B" as const, label: "B's note" }], ownerField: "ownerId", ownerValueB: "user-bob-77" };

    const call = async (method: string, url: string, body?: Uint8Array) => {
        const r = await app.inject({ method: method as never, url, headers: { "x-api-key": KEY, ...(body ? { "content-type": "application/octet-stream" } : {}) }, ...(body ? { payload: Buffer.from(body) } : {}) });
        const text = r.rawPayload.toString("utf8");
        return { status: r.statusCode, body: text.startsWith("{") ? JSON.parse(text) : text, raw: r.rawPayload };
    };
    const appOf = (id: string) => store.getApplication(id)! as never;

    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY }));
        app = await buildServer(platform);
        await app.ready();
        store = securityStoreFor(platform.db);
        pid = (await app.inject({ method: "POST", url: "/api/projects", headers: { "x-api-key": KEY, "content-type": "application/json" }, payload: JSON.stringify({ name: "Client B" }) })).json().id;
        const a = store.createApplication(pid, { name: "Notes", targetUrl: "https://notes.example.com/", environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 2, signInAccount: "alice" } as never);
        appId = a.id;
        writeDesignation(platform.db, a.id, designation, "Olga");
        store.addAuthorization(a.id, { basis: "client-permission", approverName: "Dana Client", approverRole: "Head of engineering", approverEmail: "dana@client.example", documentReference: "SOW-12", authority: "Signed engagement letter, section 4.", statement: "I confirm …", confirmedByUserId: "u1", confirmedByName: "Olga", maxProfile: "conservative-active", crossAccounts: ["alice", "bob"] });
        const admin = accessControlOf(app).users.create({ email: "admin@example.com", name: "Ada Admin", role: "owner" });
        platform.db.run("UPDATE users SET c4t_role = 'ADMIN' WHERE id = ?", admin.id);
        addApproval(platform.db, a.id, { profile: "conservative-active", environment: "staging", statement: "As a Crowd4Test admin, I approve …", byUserId: admin.id, byName: "Ada Admin" });
        new SecurityScheduleStore(platform.db).set({ id: a.id, projectId: pid }, { type: "weekly", weekday: 2, time: "03:30" }, { id: "u1", name: "Olga" });
        // The original is live: the approval counts and the schedule is on.
        expect(currentApproval(platform.db, appOf(a.id), "conservative-active")).toBeDefined();
        expect(new SecurityScheduleStore(platform.db).get(a.id)).toMatchObject({ enabled: true });
    }, 60_000);
    afterAll(async () => {
        await app?.close();
        platform?.db.close();
    });

    it("exports each table with references, names only, and lists the test accounts to sign in again", async () => {
        const r = await call("GET", `/api/projects/${pid}/backup`);
        expect(r.status).toBe(200);
        zip = new Uint8Array(r.raw);
        const files = unzipSync(zip);
        const doc = JSON.parse(strFromU8(files["security.json"]!));
        expect(doc.authorizations[0]).toMatchObject({ maxProfile: "conservative-active", crossAccounts: ["alice", "bob"], approverRole: "Head of engineering", authority: "Signed engagement letter, section 4." });
        expect(doc.profileApprovals).toEqual([{ applicationRef: "app-1", profile: "conservative-active", environment: "staging", approvedByName: "Ada Admin", approvedAt: expect.any(String), statement: "As a Crowd4Test admin, I approve …", withdrawnAt: null, withdrawnBy: null }]);
        expect(doc.schedules).toEqual([expect.objectContaining({ applicationRef: "app-1", cadence: { type: "weekly", weekday: 2, time: "03:30" }, enabled: true, makerName: "Olga" })]);
        expect(doc.crossAccount).toEqual([{ applicationRef: "app-1", designation, updatedAt: expect.any(String) }]);
        const text = strFromU8(files["security.json"]!);
        expect(text).not.toContain(appId);
        expect(text).not.toMatch(/approvedByUserId|makerId|maker_id/);
        const needs = JSON.parse(strFromU8(files["secrets-needed.json"]!)) as Array<{ label: string }>;
        const labels = needs.map((n) => n.label);
        expect(labels).toEqual(expect.arrayContaining(["Test account “alice” for the cross-account checks of “Notes”", "Test account “bob” for the cross-account checks of “Notes”"]));
        expect(JSON.parse(strFromU8(files["manifest.json"]!)).counts).toMatchObject({ securityProfileApprovals: 1, securitySchedules: 1, securityCrossAccount: 1 });
    });

    it("restores each table with new ids; the approval never counts, the schedule is switched off, the authorization withdrawn", async () => {
        const r = await call("POST", "/api/projects/restore?name=Copy", zip);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.restored).toMatchObject({ securityProfileApprovals: 1, securitySchedules: 1, securityCrossAccount: 1 });
        const notes = r.body.notes.join(" ");
        expect(notes).toMatch(/profile approvals were restored as history and withdrawn/);
        expect(notes).toMatch(/schedules were restored switched off/);
        const np = r.body.project.id as string;
        const na = store.listApplications(np)[0]!;
        expect(na.id).not.toBe(appId);

        const auth = store.listAuthorizations(na.id)[0]!;
        expect(auth).toMatchObject({ maxProfile: "conservative-active", crossAccounts: ["alice", "bob"], approverRole: "Head of engineering", authority: "Signed engagement letter, section 4.", confirmedByUserId: null });
        expect(auth.revokedAt).not.toBeNull();
        expect(store.currentAuthorization(na)).toBeUndefined();

        const approvals = listApprovals(platform.db, na.id);
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({ profile: "conservative-active", environment: "staging", approvedByName: "Ada Admin", approvedByUserId: null, detailsFingerprint: null, withdrawnBy: "Restored from a backup: a Crowd4Test admin approves again on this server." });
        expect(approvals[0]!.withdrawnAt).not.toBeNull();
        expect(currentApproval(platform.db, na as never, "conservative-active")).toBeUndefined();
        // Even if someone cleared the withdrawal by hand, it still could not count: no approver id, no fingerprint.
        platform.db.run("UPDATE security_profile_approvals SET withdrawn_at = NULL WHERE application_id = ?", na.id);
        expect(currentApproval(platform.db, na as never, "conservative-active")).toBeUndefined();

        const sched = new SecurityScheduleStore(platform.db);
        expect(sched.get(na.id)).toMatchObject({ projectId: np, cadence: { type: "weekly", weekday: 2, time: "03:30" }, enabled: false, nextRunAt: null, lastOutcome: "stopped" });
        expect(sched.due(Date.now() + 365 * 86_400_000).map((x) => x.applicationId)).not.toContain(na.id);

        expect(readDesignation(platform.db, na.id)).toEqual(designation);

        // The original is untouched.
        expect(currentApproval(platform.db, appOf(appId), "conservative-active")).toBeDefined();
        expect(sched.get(appId)).toMatchObject({ enabled: true });
    });

    it("a backup made before these fields restores as before; a schedule pointing nowhere is refused as damaged", async () => {
        const files = unzipSync(zip);
        const old = JSON.parse(strFromU8(files["security.json"]!));
        for (const k of ["profileApprovals", "schedules", "crossAccount"]) delete old[k];
        for (const a of old.authorizations) for (const k of ["maxProfile", "crossAccounts", "approverRole", "authority", "detailsFingerprint"]) delete a[k];
        const r = await call("POST", "/api/projects/restore?name=Older", zipSync({ ...files, "security.json": strToU8(JSON.stringify(old)) }));
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        const na = store.listApplications(r.body.project.id)[0]!;
        expect(store.listAuthorizations(na.id)[0]).toMatchObject({ maxProfile: "passive", crossAccounts: [], approverRole: null });
        expect(listApprovals(platform.db, na.id)).toEqual([]);

        const broken = JSON.parse(strFromU8(files["security.json"]!));
        broken.schedules[0].applicationRef = "app-9";
        const bad = await call("POST", "/api/projects/restore", zipSync({ ...files, "security.json": strToU8(JSON.stringify(broken)) }));
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe("The backup is damaged: security.json: a profile approval, schedule or cross-account designation refers to something that is not in the backup.");
    });
});

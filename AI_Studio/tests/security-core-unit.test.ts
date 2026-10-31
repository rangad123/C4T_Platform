/**
 * Security Assessment, CORE without a browser or the platform server: the slot-31 tables and the store (applications, authorizations
 * and their staleness, assessments with leases and cancel, findings deduplicated by fingerprint with validation history, audit,
 * testing type, retention), and the scope guard (every refused address class, DNS answers that change, pinning, redirects out of
 * scope, excluded paths, methods, the rate limit, the request and byte caps, the stop switch) against a local server WE start.
 *
 * Ports: 7010 (the app), 7011 (the "outside" server that must never be reached). Run (it starts plain HTTP servers only):
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-core-unit.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAs } from "../src/platform/auth/actor.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { recordSecurityEvent } from "../src/security/audit.js";
import { AUTHORIZATION_WORDS, authorizationStatement, scopeFingerprint } from "../src/security/authorization.js";
import type { SecurityApplication } from "../src/security/contract.js";
import { addressClass, browserRouteGuard, checkUrl, createScopeSession, guardedFetch, inScope, ScopeError, staticTargetProblem, type Resolver, type ScopeEvent } from "../src/security/scope.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";

const APP_PORT = 7010;
const OUTSIDE_PORT = 7011;
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-core-"));
    dirs.push(d);
    return d;
};

// ── a tiny app we own ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const hits: Array<{ method: string; path: string; host: string }> = [];
const outsideHits: string[] = [];
let appServer: http.Server;
let outsideServer: http.Server;
beforeAll(async () => {
    appServer = http.createServer((req, res) => {
        hits.push({ method: req.method ?? "", path: req.url ?? "", host: String(req.headers.host ?? "") });
        const u = req.url ?? "/";
        if (u === "/to-outside") return res.writeHead(302, { location: `http://127.0.0.1:${OUTSIDE_PORT}/stolen` }).end();
        if (u === "/to-excluded") return res.writeHead(302, { location: "/admin/billing" }).end();
        if (u === "/to-inside") return res.writeHead(301, { location: "/landing" }).end();
        if (u === "/loop") return res.writeHead(302, { location: "/loop" }).end();
        if (u === "/to-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        if (u === "/big") return res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(200_000));
        res.writeHead(200, { "content-type": "text/html", "set-cookie": ["sid=abc; Path=/", "pref=1; Path=/"], "x-powered-by": "Fixture 1.0" });
        res.end(`<html><body>${req.method} ${u}</body></html>`);
    });
    outsideServer = http.createServer((req, res) => {
        outsideHits.push(req.url ?? "");
        res.end("outside");
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));
    await new Promise<void>((r) => outsideServer.listen(OUTSIDE_PORT, "127.0.0.1", r));
});
afterAll(async () => {
    await new Promise((r) => appServer.close(r));
    await new Promise((r) => outsideServer.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const app = (over: Partial<SecurityApplication> = {}): SecurityApplication => ({
    id: "a1",
    projectId: "p1",
    name: "Shop",
    targetUrl: `http://127.0.0.1:${APP_PORT}/`,
    environment: "staging",
    scope: [],
    excludedPaths: ["/admin/billing"],
    maxRequestsPerSecond: 10,
    apiSpecUrl: null,
    notes: null,
    createdAt: "",
    updatedAt: "",
    ...over,
});

/** DNS answers the test decides. */
const fakeDns = (map: Record<string, string[] | (() => string[])>): Resolver => async (host) => {
    const v = map[host];
    const list = typeof v === "function" ? v() : v;
    if (!list) throw new Error("ENOTFOUND");
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

// ── settings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("settings", () => {
    it("default on, private targets off, lenient parsing", () => {
        const d = securitySettings({});
        expect(d).toMatchObject({ enabled: true, allowPrivateTargets: false, retentionDays: 365, maxRequestsPerAssessment: 2000, maxResponseBytes: 5 * 1024 * 1024, assessmentMinutes: 30 });
        const s = securitySettings({ SECURITY_ASSESSMENT: "off", SECURITY_ALLOW_PRIVATE_TARGETS: "true", SECURITY_RETENTION_DAYS: "30", SECURITY_MAX_REQUESTS: "nonsense", SECURITY_ASSESSMENT_MINUTES: "0" });
        expect(s).toMatchObject({ enabled: false, allowPrivateTargets: true, retentionDays: 30, maxRequestsPerAssessment: 2000, assessmentMinutes: 30 });
        expect(securitySettings({ SECURITY_ASSESSMENT: "ON" }).enabled).toBe(true);
    });
});

// ── store ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("store and migration", () => {
    let db: Db;
    let store: SecurityStore;
    let p1: string;
    let p2: string;
    beforeAll(() => {
        const dir = tmp();
        db = new Db(path.join(dir, "t.db"));
        const repo = new Repo(db, new SecretBox(dir));
        p1 = repo.createProject({ name: "Client A" }).id;
        p2 = repo.createProject({ name: "Client B" }).id;
        store = new SecurityStore(db);
    });
    afterAll(() => db.close());

    it("creates every security table and index in slot 31", () => {
        const names = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master").map((r) => r.name));
        for (const t of ["security_applications", "security_authorizations", "security_assessments", "security_findings", "security_finding_history", "security_finding_sightings", "security_audit", "security_project_settings"]) expect(names.has(t), t).toBe(true);
        for (const i of ["idx_sec_apps_project", "idx_sec_assess_state", "idx_sec_find_severity", "idx_sec_find_validation", "idx_sec_find_last", "idx_sec_find_fp"]) expect(names.has(i), i).toBe(true);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBeGreaterThanOrEqual(31);
    });

    it("applications: create, read, update, list per project", () => {
        const a = store.createApplication(p1, { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging", scope: ["*.example.com"], excludedPaths: ["/admin"], maxRequestsPerSecond: 3 });
        expect(a).toMatchObject({ projectId: p1, name: "Shop", scope: ["*.example.com"], excludedPaths: ["/admin"], maxRequestsPerSecond: 3, apiSpecUrl: null, notes: null });
        expect(store.updateApplication(a.id, { notes: "Weekly" })!.notes).toBe("Weekly");
        expect(store.listApplications(p1).map((x) => x.id)).toEqual([a.id]);
        expect(store.listApplications(p2)).toEqual([]);
    });

    it("authorization: current until the target, scope, exclusions or rate change; revoked; replaced", () => {
        const a = store.createApplication(p1, { name: "Portal", targetUrl: "https://portal.example.com/", environment: "production" });
        expect(store.authorizationState(a)).toEqual({ state: "none", message: AUTHORIZATION_WORDS.none, authorizationId: null });
        const statement = authorizationStatement("Client A", a);
        expect(statement).toBe("I confirm that Client A owns https://portal.example.com/ or that its owner has given documented permission to assess it, within the scope listed. The assessment is passive: it only sends the ordinary requests a visitor's browser makes.");
        const auth = store.addAuthorization(a.id, { basis: "client-permission", approverName: "Dana Client", approverEmail: "dana@client.example", documentReference: "SOW-12", restrictions: "Weekdays only", statement, confirmedByUserId: "u1", confirmedByName: "Olga" });
        expect(auth).toMatchObject({ basis: "client-permission", approverName: "Dana Client", confirmedByName: "Olga", revokedAt: null, statement, scopeFingerprint: scopeFingerprint(a) });
        expect(store.authorizationState(a).state).toBe("current");
        expect(store.currentAuthorization(a)?.id).toBe(auth.id);

        // Name and notes do not touch the authorization; the scope fields do (each of them).
        expect(store.authorizationState(store.updateApplication(a.id, { name: "Portal 2", notes: "x", environment: "staging" })!).state).toBe("current");
        for (const patch of [{ targetUrl: "https://portal.example.com/app" }, { scope: ["api.example.com"] }, { excludedPaths: ["/x"] }, { maxRequestsPerSecond: 5 }]) {
            const changed = { ...store.getApplication(a.id)!, ...patch };
            expect(store.authorizationState(changed)).toMatchObject({ state: "stale", message: AUTHORIZATION_WORDS.stale });
            expect(store.currentAuthorization(changed)).toBeUndefined();
        }
        // Order and case of scope entries do not matter.
        expect(scopeFingerprint({ ...a, scope: ["B.example.com", "a.example.com"] })).toBe(scopeFingerprint({ ...a, scope: ["a.example.com", "b.example.com "] }));

        const second = store.addAuthorization(a.id, { basis: "owner", approverName: "Olga", statement, confirmedByName: "Olga" });
        expect(store.getAuthorization(auth.id)!.revokedAt).not.toBeNull();
        expect(store.getAuthorization(auth.id)!.revokedReason).toMatch(/Replaced/);
        expect(store.listAuthorizations(a.id).map((x) => x.id)).toEqual([second.id, auth.id]);
        store.revokeAuthorization(second.id, "Olga");
        expect(store.authorizationState(store.getApplication(a.id)!)).toMatchObject({ state: "revoked", message: AUTHORIZATION_WORDS.revoked });
    });

    it("assessments: create, one claim at a time, lease renew and expiry, cancel request, work data", () => {
        const a = store.createApplication(p1, { name: "Run", targetUrl: "https://run.example.com/", environment: "other" });
        const s = store.createAssessment({ applicationId: a.id, authorizationId: "auth-x", startedBy: "Olga" });
        expect(s).toMatchObject({ state: "QUEUED", progress: 0, projectId: p1, kind: "passive", retestOf: null, cancelRequested: false, coverage: null });
        expect(store.activeAssessment(a.id)?.id).toBe(s.id);
        const t0 = 1_000_000;
        const claimed = store.claimAssessment("loop-1", 10_000, t0);
        expect(claimed?.id).toBe(s.id);
        expect(store.claimAssessment("loop-2", 10_000, t0 + 1)).toBeUndefined();
        expect(store.renewLease(s.id, "loop-2", 10_000, t0 + 2)).toBe(false);
        expect(store.renewLease(s.id, "loop-1", 10_000, t0 + 5_000)).toBe(true);
        // The first loop died: after its lease, another one takes over (restart safety).
        expect(store.claimAssessment("loop-2", 10_000, t0 + 16_000)?.id).toBe(s.id);
        store.updateAssessment(s.id, { state: "SCANNING", progress: 140, progressText: "Checking headers", coverage: { pagesSeen: 3, formsSeen: 1, apiCallsSeen: 0, notInspected: ["Signed-in pages"] }, startedAt: "2026-01-01T00:00:00.000Z" });
        expect(store.getAssessment(s.id)).toMatchObject({ state: "SCANNING", progress: 100, coverage: { pagesSeen: 3 } });
        store.setWorkData(s.id, { pages: ["/"] });
        expect(store.getWorkData(s.id)).toEqual({ pages: ["/"] });
        expect(store.requestCancel(s.id)).toBe(true);
        expect(store.cancelRequested(s.id)).toBe(true);
        store.updateAssessment(s.id, { state: "CANCELLED", finishedAt: new Date().toISOString() });
        expect(store.requestCancel(s.id)).toBe(false);
        expect(store.activeAssessment(a.id)).toBeUndefined();
        expect(store.listAssessments({ projectId: p2 })).toEqual([]);
        expect(store.listAssessments({ projectId: p1, states: ["CANCELLED"] }).map((x) => x.id)).toEqual([s.id]);
    });

    it("findings: upsert by fingerprint keeps people's validation, records sightings and history", () => {
        const a = store.createApplication(p1, { name: "Find", targetUrl: "https://find.example.com/", environment: "other" });
        const s1 = store.createAssessment({ applicationId: a.id, authorizationId: "x", startedBy: "Olga" });
        const s2 = store.createAssessment({ applicationId: a.id, authorizationId: "x", startedBy: "Olga" });
        const base = { projectId: p1, applicationId: a.id, fingerprint: "headers:csp:https://find.example.com/", title: "No Content-Security-Policy", category: "headers" as const, severity: "medium" as const, confidence: "high" as const, location: "https://find.example.com/", description: "d", impact: "i", remediation: "r", evidence: [{ kind: "response-header" as const, label: "content-security-policy", value: "(missing)", observedAt: "t" }], source: "built-in" as const };
        const first = store.upsertFinding({ ...base, assessmentId: s1.id, initialValidation: "probable" });
        expect(first.created).toBe(true);
        expect(first.finding).toMatchObject({ validation: "probable", firstAssessmentId: s1.id, lastAssessmentId: s1.id });
        runAs({ kind: "user", id: "u7", name: "Ana", role: "editor" }, () => store.setValidation(first.finding.id, "confirmed", { comment: "Seen in the browser too" }));
        const again = store.upsertFinding({ ...base, assessmentId: s2.id, severity: "high", initialValidation: "needs-review" });
        expect(again.created).toBe(false);
        expect(again.finding).toMatchObject({ id: first.finding.id, validation: "confirmed", severity: "high", firstAssessmentId: s1.id, lastAssessmentId: s2.id });
        expect(store.findingIdsSeenIn(s1.id).has(first.finding.id)).toBe(true);
        expect(store.findingIdsSeenIn(s2.id).has(first.finding.id)).toBe(true);
        expect(store.findingHistory(first.finding.id)).toEqual([expect.objectContaining({ actor: "Ana (u7)", actorId: "u7", from: "probable", to: "confirmed", comment: "Seen in the browser too" })]);
        store.addFindingNote(first.finding.id, "Still present", s2.id);
        expect(store.findingHistory(first.finding.id)[1]).toMatchObject({ from: null, to: null, comment: "Still present", assessmentId: s2.id, actor: "Platform" });
        // Filters
        expect(store.listFindings({ projectId: p1, severities: ["high"] }).map((f) => f.id)).toEqual([first.finding.id]);
        expect(store.listFindings({ projectId: p1, severities: ["low"] })).toEqual([]);
        expect(store.countFindings({ projectId: p1, q: "content-security" })).toBe(1);
        expect(store.countFindings({ projectId: p1, q: "100%_" })).toBe(0);
        expect(store.listFindings({ projectId: p2 })).toEqual([]);
        // Deleting the application takes its findings; the audit trail is not touched.
        store.deleteApplication(a.id);
        expect(store.getFinding(first.finding.id)).toBeUndefined();
    });

    it("audit rows say who; recordSecurityEvent also lists the event in the platform Activity", () => {
        runAs({ kind: "user", id: "u1", name: "Olga", role: "owner" }, () =>
            recordSecurityEvent(db, { projectId: p1, applicationId: null, action: "testing-type.changed", objectType: "project", objectId: p1, summary: "Set the testing type to both." }),
        );
        const [row] = store.listAudit(p1, { limit: 1 });
        expect(row).toMatchObject({ action: "testing-type.changed", actor: { kind: "user", id: "u1", name: "Olga" }, summary: "Set the testing type to both." });
        const act = db.get("SELECT * FROM activity WHERE action = 'security:testing-type.changed'");
        expect(act).toMatchObject({ actor_kind: "user", actor_id: "u1", actor_name: "Olga", project_id: p1, detail: "Set the testing type to both." });
        expect(store.listAudit(p2)).toEqual([]);
    });

    it("testing type: functional until set", () => {
        expect(store.testingType(p2)).toBe("functional");
        store.setTestingType(p2, "both");
        expect(store.testingType(p2)).toBe("both");
        store.setTestingType(p2, "security");
        expect(store.testingType(p2)).toBe("security");
    });

    it("retention removes finished assessments past the period with their sightings; findings keep their latest evidence", () => {
        const a = store.createApplication(p2, { name: "Old", targetUrl: "https://old.example.com/", environment: "other" });
        const old = store.createAssessment({ applicationId: a.id, authorizationId: "x", startedBy: "Olga" });
        const recent = store.createAssessment({ applicationId: a.id, authorizationId: "x", startedBy: "Olga" });
        const running = store.createAssessment({ applicationId: a.id, authorizationId: "x", startedBy: "Olga" });
        const day = 86_400_000;
        const now = Date.parse("2027-06-01T00:00:00.000Z");
        store.updateAssessment(old.id, { state: "COMPLETED", finishedAt: new Date(now - 40 * day).toISOString() });
        store.updateAssessment(recent.id, { state: "COMPLETED", finishedAt: new Date(now - 5 * day).toISOString() });
        const f = store.upsertFinding({ projectId: p2, applicationId: a.id, assessmentId: old.id, fingerprint: "fp-old", title: "t", category: "cookies", severity: "low", confidence: "medium", location: "/", description: "d", impact: "i", remediation: "r", evidence: [{ kind: "cookie", label: "sid", value: "HttpOnly missing", observedAt: "t" }], source: "built-in" });
        const r = store.prune(30, now);
        // (the cancelled assessment of the earlier test, in the other project, is past the period too)
        expect(r).toMatchObject({ assessments: 2, sightings: 1, byProject: { [p1]: 1, [p2]: 1 } });
        expect(store.getAssessment(old.id)).toBeUndefined();
        expect(store.getAssessment(recent.id)).toBeDefined();
        expect(store.getAssessment(running.id)).toBeDefined();
        expect(store.getFinding(f.finding.id)).toMatchObject({ firstAssessmentId: null, lastAssessmentId: null, evidence: [{ label: "sid" }] });
    });
});

// ── scope guard ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("address classes", () => {
    it("names every refused class, judges IPv4 inside IPv6 forms, and leaves public addresses alone", () => {
        const cases: Array<[string, string | null]> = [
            ["127.0.0.1", "loopback"],
            ["127.255.0.9", "loopback"],
            ["::1", "loopback"],
            ["10.1.2.3", "private"],
            ["172.16.0.1", "private"],
            ["172.31.255.255", "private"],
            ["192.168.1.1", "private"],
            ["fd12:3456::1", "private"],
            ["fc00::1", "private"],
            ["169.254.1.1", "link-local"],
            ["fe80::1", "link-local"],
            ["100.64.0.1", "cgnat"],
            ["100.127.255.255", "cgnat"],
            ["224.0.0.1", "multicast"],
            ["ff02::1", "multicast"],
            ["0.0.0.0", "unspecified"],
            ["::", "unspecified"],
            ["255.255.255.255", "broadcast"],
            ["240.0.0.1", "reserved"],
            ["192.0.2.10", "reserved"],
            ["2001:db8::1", "reserved"],
            ["169.254.169.254", "cloud-metadata"],
            ["fd00:ec2::254", "cloud-metadata"],
            ["100.100.100.200", "cloud-metadata"],
            ["::ffff:127.0.0.1", "loopback"],
            ["::ffff:7f00:1", "loopback"],
            ["::ffff:169.254.169.254", "cloud-metadata"],
            ["64:ff9b::10.0.0.1", "private"],
            ["2002:7f00:1::", "loopback"],
            ["8.8.8.8", null],
            ["172.32.0.1", null],
            ["100.128.0.1", null],
            ["2606:4700::1111", null],
        ];
        for (const [ip, cls] of cases) expect(addressClass(ip), ip).toBe(cls);
    });

    it("refuses odd spellings of private addresses that the URL parser normalizes", async () => {
        for (const raw of ["http://2130706433/", "http://0x7f.1/", "http://[::ffff:127.0.0.1]/", "http://127.1/"]) {
            const d = await checkUrl(raw, app({ targetUrl: raw }), { resolver: fakeDns({}) });
            expect(d.allowed, raw).toBe(false);
            if (!d.allowed) expect(d.code, raw).toBe("blocked-address");
        }
    });
});

describe("scope rules", () => {
    const a = app({ targetUrl: "https://shop.example.com/", scope: ["https://api.example.com", "*.cdn.example.net", "static.example.org", "reports.example.org:8443"], excludedPaths: ["/admin/billing", "/Danger"] });
    it("accepts the target origin and scope entries only", () => {
        for (const ok of ["https://shop.example.com/x?y=1", "https://api.example.com/v1", "https://img.cdn.example.net/a.png", "https://static.example.org/", "http://static.example.org/", "https://reports.example.org:8443/r"]) expect(inScope(ok, a).ok, ok).toBe(true);
        for (const no of ["http://shop.example.com/", "https://shop.example.com:8443/", "https://api.example.com:444/", "https://cdn.example.net/", "https://evil-cdn.example.net/", "https://static.example.org:8080/", "https://example.com/", "https://shop.example.com.evil.test/"]) {
            const v = inScope(no, a);
            expect(v.ok, no).toBe(false);
            if (!v.ok) expect(v.code, no).toBe("out-of-scope");
        }
    });
    it("refuses other schemes, credentials in the address, and excluded paths however they are spelled", () => {
        expect(inScope("ftp://shop.example.com/", a)).toMatchObject({ ok: false, code: "scheme" });
        expect(inScope("javascript:alert(1)", a)).toMatchObject({ ok: false, code: "scheme" });
        expect(inScope("https://u:p@shop.example.com/", a)).toMatchObject({ ok: false, code: "credentials" });
        for (const p of ["/admin/billing", "/admin/billing/2024", "/ADMIN/Billing", "//admin//billing", "/admin/%62illing", "/x/../admin/billing", "/admin%2Fbilling", "/danger/zone"]) {
            expect(inScope(`https://shop.example.com${p}`, a), p).toMatchObject({ ok: false, code: "excluded-path" });
        }
        expect(inScope("https://shop.example.com/admin/other", a).ok).toBe(true);
    });
    it("says at registration which targets can never be assessed", () => {
        expect(staticTargetProblem("http://169.254.169.254/", true)).toMatch(/metadata/);
        expect(staticTargetProblem("http://metadata.google.internal/", true)).toMatch(/metadata/);
        expect(staticTargetProblem("http://127.0.0.1:3000/", false)).toMatch(/SECURITY_ALLOW_PRIVATE_TARGETS/);
        expect(staticTargetProblem("http://localhost:3000/", false)).toMatch(/SECURITY_ALLOW_PRIVATE_TARGETS/);
        expect(staticTargetProblem("http://127.0.0.1:3000/", true)).toBeUndefined();
        expect(staticTargetProblem("https://shop.example.com/", false)).toBeUndefined();
        expect(staticTargetProblem("file:///etc/passwd", true)).toMatch(/http and https/);
    });
});

describe("DNS", () => {
    const a = app({ targetUrl: "https://shop.example.com/", excludedPaths: [] });
    it("refuses a name when any of its answers is not allowed, and metadata names always", async () => {
        expect(await checkUrl("https://shop.example.com/", a, { resolver: fakeDns({ "shop.example.com": ["93.184.216.34"] }) })).toMatchObject({ allowed: true, address: "93.184.216.34", family: 4 });
        expect(await checkUrl("https://shop.example.com/", a, { resolver: fakeDns({ "shop.example.com": ["93.184.216.34", "10.0.0.8"] }) })).toMatchObject({ allowed: false, code: "blocked-address" });
        expect(await checkUrl("https://shop.example.com/", a, { resolver: fakeDns({ "shop.example.com": ["169.254.169.254"] }), allowPrivate: true })).toMatchObject({ allowed: false, code: "cloud-metadata" });
        expect(await checkUrl("https://shop.example.com/", a, { resolver: fakeDns({}) })).toMatchObject({ allowed: false, code: "dns-failed" });
        const meta = app({ targetUrl: "http://metadata.google.internal/" });
        expect(await checkUrl("http://metadata.google.internal/computeMetadata/v1/", meta, { allowPrivate: true, resolver: fakeDns({ "metadata.google.internal": ["8.8.8.8"] }) })).toMatchObject({ allowed: false, code: "cloud-metadata" });
        // private allowed by the setting (the tests' own fixtures), still per answer
        expect(await checkUrl("https://shop.example.com/", a, { resolver: fakeDns({ "shop.example.com": ["10.0.0.8"] }), allowPrivate: true })).toMatchObject({ allowed: true, address: "10.0.0.8" });
    });

    it("judges every lookup on its own: an answer that changes to a private address is refused (rebinding)", async () => {
        let n = 0;
        const resolver = fakeDns({ "shop.example.com": () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]) });
        expect((await checkUrl("https://shop.example.com/", a, { resolver })).allowed).toBe(true);
        expect(await checkUrl("https://shop.example.com/", a, { resolver })).toMatchObject({ allowed: false, code: "blocked-address" });
    });

    it("connects to the address that was checked, not to a second lookup (pinning)", async () => {
        // "app.test" exists only in this resolver: the request can only arrive if the connection uses the checked address.
        let lookups = 0;
        const resolver: Resolver = async () => (lookups++, [{ address: "127.0.0.1", family: 4 }]);
        const s = createScopeSession(app({ targetUrl: `http://app.test:${APP_PORT}/` }), { allowPrivate: true, resolver });
        const before = hits.length;
        const r = await guardedFetch(s, `http://app.test:${APP_PORT}/pinned`);
        expect(r).toMatchObject({ status: 200, address: "127.0.0.1", truncated: false });
        expect(lookups).toBe(1);
        expect(hits.slice(before)).toEqual([{ method: "GET", path: "/pinned", host: `app.test:${APP_PORT}` }]);
        expect(r.setCookies).toEqual(["sid=abc; Path=/", "pref=1; Path=/"]);
        expect(r.headers["x-powered-by"]).toBe("Fixture 1.0");
    });
});

describe("guardedFetch against the local app", () => {
    const events: ScopeEvent[] = [];
    const session = (over: Partial<SecurityApplication> = {}, opts: Parameters<typeof createScopeSession>[1] = {}) => createScopeSession(app(over), { allowPrivate: true, onEvent: (e) => events.push(e), ...opts });

    it("is refused for private targets unless the setting allows them", async () => {
        const s = createScopeSession(app());
        await expect(guardedFetch(s, `http://127.0.0.1:${APP_PORT}/`)).rejects.toMatchObject({ code: "blocked-address" });
        expect(s.stats.requests).toBe(0);
    });

    it("follows in-scope redirects, re-checking each hop", async () => {
        const r = await guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/to-inside`);
        expect(r.status).toBe(200);
        expect(r.url).toBe(`http://127.0.0.1:${APP_PORT}/landing`);
        expect(r.redirects).toEqual([{ url: `http://127.0.0.1:${APP_PORT}/to-inside`, status: 301, location: `http://127.0.0.1:${APP_PORT}/landing` }]);
    });

    it("never follows a redirect out of scope, into an excluded path, or to a metadata address", async () => {
        const before = hits.length;
        const out = await guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/to-outside`);
        expect(out.status).toBe(302);
        expect(out.blockedRedirect).toMatchObject({ code: "out-of-scope", url: `http://127.0.0.1:${OUTSIDE_PORT}/stolen` });
        const ex = await guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/to-excluded`);
        expect(ex.blockedRedirect).toMatchObject({ code: "excluded-path" });
        const md = await guardedFetch(session({ scope: ["169.254.169.254"] }), `http://127.0.0.1:${APP_PORT}/to-metadata`);
        expect(md.blockedRedirect).toMatchObject({ code: "cloud-metadata" });
        expect(outsideHits).toEqual([]);
        expect(hits.slice(before).map((h) => h.path)).toEqual(["/to-outside", "/to-excluded", "/to-metadata"]);
        expect(events.some((e) => e.type === "blocked" && e.via === "redirect" && e.code === "out-of-scope")).toBe(true);
    });

    it("stops after the redirect limit", async () => {
        const r = await guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/loop`, { maxRedirects: 2 });
        expect(r.status).toBe(302);
        expect(r.redirects).toHaveLength(2);
    });

    it("never requests an excluded path or another origin, and sends only GET, HEAD and OPTIONS", async () => {
        const before = hits.length;
        await expect(guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/admin/billing/invoices`)).rejects.toMatchObject({ code: "excluded-path" });
        await expect(guardedFetch(session(), `http://127.0.0.1:${OUTSIDE_PORT}/`)).rejects.toMatchObject({ code: "out-of-scope" });
        await expect(guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/login`, { method: "POST" as never })).rejects.toMatchObject({ code: "method" });
        const head = await guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/h`, { method: "HEAD" });
        expect(head.body.length).toBe(0);
        const opt = await guardedFetch(session(), `http://127.0.0.1:${APP_PORT}/o`, { method: "OPTIONS", headers: { origin: "https://elsewhere.example", host: "evil.example" } });
        expect(opt.status).toBe(200);
        expect(hits.slice(before)).toEqual([
            { method: "HEAD", path: "/h", host: `127.0.0.1:${APP_PORT}` },
            { method: "OPTIONS", path: "/o", host: `127.0.0.1:${APP_PORT}` },
        ]);
        expect(outsideHits).toEqual([]);
    });

    it("reads at most the per-response byte cap and says so", async () => {
        const r = await guardedFetch(session({}, { maxResponseBytes: 16 * 1024 }), `http://127.0.0.1:${APP_PORT}/big`);
        expect(r.truncated).toBe(true);
        expect(r.body.length).toBe(16 * 1024);
    });

    it("refuses requests past the request cap (redirect hops count too)", async () => {
        const s = session({}, { maxRequests: 3 });
        await guardedFetch(s, `http://127.0.0.1:${APP_PORT}/one`);
        await guardedFetch(s, `http://127.0.0.1:${APP_PORT}/to-inside`);
        expect(s.stats.requests).toBe(3);
        const err = await guardedFetch(s, `http://127.0.0.1:${APP_PORT}/three`).catch((e) => e);
        expect(err).toBeInstanceOf(ScopeError);
        expect(err.code).toBe("request-limit");
    });

    it("waits for the rate limit (token bucket from the application's requests per second)", async () => {
        let t = 0;
        const sleeps: number[] = [];
        const clock = { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) };
        const s = createScopeSession(app({ maxRequestsPerSecond: 2 }), { allowPrivate: true, clock });
        for (let i = 0; i < 6; i++) await s.take();
        // Two at once (the bucket), then one every 500 ms: four waits, 2 s of simulated time for six requests.
        expect(sleeps).toEqual([500, 500, 500, 500]);
        expect(t).toBe(2000);
        expect(s.stats.requests).toBe(6);
    });

    it("really spaces requests in time at 2 per second", async () => {
        const s = session({ maxRequestsPerSecond: 2 });
        const t0 = Date.now();
        for (let i = 0; i < 4; i++) await guardedFetch(s, `http://127.0.0.1:${APP_PORT}/rate-${i}`);
        // 2 immediately, then 2 more at ~500 ms intervals: at least ~1 s (wide margin for a slow machine).
        expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    });

    it("stops: waiting requests fail and nothing more is sent", async () => {
        const ctl = new AbortController();
        const s = session({ maxRequestsPerSecond: 1 }, { signal: ctl.signal });
        await s.take();
        const waiting = s.take();
        ctl.abort();
        await expect(waiting).rejects.toMatchObject({ code: "stopped" });
        await expect(guardedFetch(s, `http://127.0.0.1:${APP_PORT}/after-stop`)).rejects.toMatchObject({ code: "stopped" });
        expect(hits.some((h) => h.path === "/after-stop")).toBe(false);
    });

    it("builds a browser handler from an application too (the browser test drives it for real)", () => {
        expect(typeof browserRouteGuard(app())).toBe("function");
    });
});

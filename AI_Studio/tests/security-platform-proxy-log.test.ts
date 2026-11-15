/**
 * One request log per assessment: the platform's own checks (the steps and the cross-account reads) are stored beside the scanners' runs,
 * and the assessment's scans address returns them together, each entry with its source, with per-source totals and a per-source cap.
 *
 * A real assessment runs through the real loop against a local fixture (a browser for discovery, two saved sign-ins for the
 * cross-account step); the scanner's part is a run row whose log comes from a real request guard started as a scanner's. Ports 9745-9746.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { IdentityStore } from "../src/platform/identity-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { AssessmentLoop, type RunnerDeps } from "../src/security/assessment/runner.js";
import { FINISHED_STATES, type SecurityAssessment } from "../src/security/contract.js";
import { egressCoverage, startEgressGuard, type EgressCounts, type EgressEntry } from "../src/security/egress/guard.js";
import { MAX_PER_SOURCE, mergeRequestLogs, RequestLog } from "../src/security/egress/request-log.js";
import { loopDeps } from "../src/security/routes/assessments.js";
import { createRun, requestLogOfAssessment, runsOfAssessment, listRuns, savePlatformRequests, updateRun } from "../src/security/scanners/store.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";

const API = "/api/v1/security";
const PORT = 9745;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSIONS: Record<string, string> = { "alice-session-cookie-4471": "user-alice-11", "bob-session-cookie-9902": "user-bob-77" };
/** A reset-token-like path segment: the shared redaction hides it wherever a path is logged. */
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const received: Array<{ method: string; url: string; via: boolean }> = [];

function fixtureApp(): http.Server {
    return http.createServer((req, res) => {
        received.push({ method: req.method ?? "", url: req.url ?? "", via: String(req.headers.via ?? "").includes("c4t-request-guard") });
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        const me = sid ? SESSIONS[sid] : undefined;
        const send = (status: number, body: unknown, type = "application/json") => {
            res.writeHead(status, { "content-type": type });
            res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        const u = new URL(req.url ?? "/", ORIGIN);
        if (u.pathname === "/") return send(200, `<!doctype html><title>Notes</title><h1>Notes</h1><a href="/about">About</a>`, "text/html");
        if (u.pathname === "/about") return send(200, "<!doctype html><title>About</title><p>About</p>", "text/html");
        if (!me) return send(401, { error: "Sign in first" });
        if (u.pathname === "/api/notes/50123") return send(200, { id: 50123, ownerId: "user-bob-77", title: "Bob's note" });
        if (u.pathname === "/api/notes/40111") return send(200, { id: 40111, ownerId: "user-alice-11", title: "Alice's note" });
        return send(404, { error: "Not found" });
    });
}

type Inject = Awaited<ReturnType<typeof buildServer>>;
let dir: string;
let platform: Platform;
let server: Inject;
let fixture: http.Server;
let store: SecurityStore;
let projectId: string;
let appId: string;
let deps: RunnerDeps;
let run: SecurityAssessment;
const launched: Browser[] = [];

async function api(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) {
    const r = await server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
    let json: any;
    try {
        json = r.json();
    } catch {
        json = undefined;
    }
    return { status: r.statusCode, json };
}

const stateFor = (value: string) => ({ cookies: [{ name: "sid", value, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] });
type Log = { entries: EgressEntry[]; totals: Record<string, EgressCounts>; capPerSource: number; notListed: Record<string, number> };

beforeAll(async () => {
    fixture = fixtureApp();
    await new Promise<void>((r) => fixture.listen(PORT, "127.0.0.1", () => r()));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-proxy-log-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", WORKER_EMBEDDED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
    store = new SecurityStore(platform.db);
    projectId = platform.repo.createProject({ name: "Request log client" }).id as string;
    new IdentityStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).set(projectId, [
        { name: "alice", username: "alice@example.test", password: "never-typed-1" },
        { name: "bob", username: "bob@example.test", password: "never-typed-2" },
    ]);
    deps = {
        ...loopDeps({ p: platform, settings: securitySettings(platform.config) }),
        limits: { maxPages: 3 },
        launch: async () => {
            const b = await launchChromium(true);
            launched.push(b);
            return b;
        },
    };
    const r = await api("POST", `${API}/projects/${projectId}/applications`, { targetUrl: `${ORIGIN}/`, maxRequestsPerSecond: 10, name: "Notes (staging)", environment: "staging", excludedPaths: ["/admin"] });
    appId = r.json.application.id;
    for (const [account, value] of [["alice", "alice-session-cookie-4471"], ["bob", "bob-session-cookie-9902"]] as const) expect((await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account, storageState: stateFor(value) })).status).toBe(200);
    const designation = { accountA: "alice", accountB: "bob", ownerField: "ownerId", ownerValueA: "user-alice-11", ownerValueB: "user-bob-77", resources: [{ path: "/api/notes/40111", kind: "item", owner: "A" }, { path: "/api/notes/50123", kind: "item", owner: "B" }] };
    expect((await api("PUT", `${API}/applications/${appId}/cross-account`, designation)).status).toBe(200);
    const authorized = await api("POST", `${API}/applications/${appId}/authorizations`, { basis: "owner", approverName: "Test Owner", approverRole: "Head of Engineering", approverEmail: "owner@client.example", documentReference: "SOW-1", authority: "Signed SOW-1 for the application's owner.", confirm: true, crossAccounts: ["alice", "bob"] });
    expect(authorized.status, JSON.stringify(authorized.json)).toBe(201);

    const started = await api("POST", `${API}/applications/${appId}/assessments`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(201);
    const aid = started.json.assessment.id as string;
    const loop = new AssessmentLoop(deps, 100);
    loop.start();
    try {
        const end = Date.now() + 150_000;
        for (;;) {
            run = store.getAssessment(aid)!;
            if (FINISHED_STATES.includes(run.state)) break;
            if (Date.now() > end) throw new Error("assessment did not finish");
            await new Promise((r2) => setTimeout(r2, 150));
        }
    } finally {
        await loop.stop();
    }

    // The scanner's part of the same assessment: a run row whose log is a real request guard's, started as a scanner's is.
    const guard = await startEgressGuard({ app: store.getApplication(appId)!, allowPrivate: true, source: "scanner:nuclei" });
    const viaProxy = (method: string, url: string) =>
        new Promise<void>((resolve, reject) => {
            const q = http.request({ host: "127.0.0.1", port: guard.port, method, path: url, headers: { "x-c4t-source": "platform:discovery" } }, (res) => (res.resume(), res.on("end", () => resolve())));
            q.on("error", reject);
            q.end();
        });
    await viaProxy("GET", `${ORIGIN}/about?token=${TOKEN}`);
    await viaProxy("GET", `${ORIGIN}/reset/${TOKEN}`);
    await viaProxy("POST", `${ORIGIN}/api/notes`);
    await viaProxy("GET", `${ORIGIN}/admin/users`);
    const scannerRun = createRun(platform.db, { assessmentId: run.id, projectId, applicationId: appId, scanner: "nuclei", profile: "passive", approval: null });
    const g = egressCoverage("Nuclei", guard);
    updateRun(platform.db, scannerRun.id, { state: "COMPLETED", coverage: { inspected: g.inspected, notInspected: g.notInspected, requestLog: g.requestLog } });
    await guard.close();
}, 300_000);

afterAll(async () => {
    for (const b of launched) await b.close().catch(() => undefined);
    await server?.close();
    platform?.db.close?.();
    await new Promise((r) => fixture?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the assessment's one request log", () => {
    let log: Log;
    let runs: Array<{ scanner: string }>;

    it("one read returns the scanner's and the platform's requests together, each with its source", async () => {
        expect(run.state, run.error ?? "").toMatch(/COMPLETED/);
        const r = await api("GET", `${API}/assessments/${run.id}/scans`);
        expect(r.status).toBe(200);
        log = r.json.requestLog;
        runs = r.json.runs;
        const sources = [...new Set(log.entries.map((e) => e.source))].sort();
        expect(sources).toEqual(expect.arrayContaining(["platform:checks", "platform:cross-account", "platform:discovery", "scanner:nuclei"]));
        expect(sources.every((s) => /^(platform:[a-z-]+|scanner:nuclei)$/.test(String(s)))).toBe(true);
        // Same fields for every entry, whoever sent it; never a query string, a header or a body.
        for (const e of log.entries) {
            expect(Object.keys(e).every((k) => ["at", "source", "method", "host", "path", "verdict", "status", "reason"].includes(k))).toBe(true);
            expect(e.path).not.toContain("?");
        }
        // In time order.
        expect(log.entries.map((e) => e.at)).toEqual(log.entries.map((e) => e.at).sort());
        // The platform's rows are not tool runs: the run lists show the scanner only.
        expect(runs.map((x) => x.scanner)).toEqual(["nuclei"]);
        // Each entry is answered once: in `requestLog`, not again inside each run's coverage.
        expect(runs.every((x) => !("requestLog" in ((x as { coverage?: object }).coverage ?? {})))).toBe(true);
        expect(r.json.runs[0].coverage.inspected.length).toBeGreaterThan(0);
        expect(runsOfAssessment(platform.db, run.id).map((x) => x.scanner)).toEqual(["nuclei"]);
        expect(listRuns(platform.db, projectId).map((x) => x.scanner)).toEqual(["nuclei"]);
    });

    it("attributes correctly: a scanner's entries stay the scanner's, and the cross-account reads are there", () => {
        // The scanner claimed "platform:discovery" in a header on every request: none of it is the platform's.
        const scanner = log.entries.filter((e) => e.source === "scanner:nuclei");
        expect(scanner.map((e) => `${e.method} ${e.verdict}`)).toEqual(["GET allowed", "GET allowed", "POST refused", "GET refused"]);
        expect(log.entries.filter((e) => e.source?.startsWith("platform:") && e.method === "POST")).toEqual([]);
        // Cross-account: A's, B's and the visitor's read of each designated resource, all through the guard.
        const cross = log.entries.filter((e) => e.source === "platform:cross-account");
        expect(cross.length).toBeGreaterThanOrEqual(4);
        expect(new Set(cross.map((e) => e.path))).toEqual(new Set(["/api/notes/40111", "/api/notes/50123"]));
        expect(cross.every((e) => e.method === "GET" && e.verdict === "allowed")).toBe(true);
        expect(log.entries.some((e) => e.source === "platform:discovery" && e.path === "/" && e.verdict === "allowed")).toBe(true);
        // Everything the application received came through the guard.
        expect(received.length).toBeGreaterThan(0);
        expect(received.every((x) => x.via)).toBe(true);
    });

    it("keeps totals per source, and they add up to the entries listed", () => {
        expect(log.capPerSource).toBe(MAX_PER_SOURCE);
        expect(log.notListed).toEqual({});
        for (const [source, c] of Object.entries(log.totals)) {
            const mine = log.entries.filter((e) => e.source === source);
            expect(c.total, source).toBe(mine.length);
            expect(c.allowed + c.refused + c.failed, source).toBe(c.total);
            expect(c.refused, source).toBe(mine.filter((e) => e.verdict === "refused").length);
        }
        expect(log.totals["scanner:nuclei"]).toMatchObject({ total: 4, allowed: 2, refused: 2, byMethod: { GET: 3, POST: 1 } });
        expect(log.totals["platform:cross-account"]!.total).toBeGreaterThanOrEqual(4);
        // The application's own count agrees: every allowed entry is one request it received.
        expect(Object.values(log.totals).reduce((n, c) => n + c.allowed, 0)).toBe(received.length);
    });

    it("applies the shared redaction to every source, and stores no sign-in value", async () => {
        const text = JSON.stringify(log);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain("session-cookie");
        expect(log.entries.some((e) => e.source === "scanner:nuclei" && e.path.startsWith("/reset/") && !e.path.includes(TOKEN))).toBe(true);
        // A platform log that comes back with a token in a path, a query string or another sender's name (from a runner) is cleaned when stored.
        const other = (await api("POST", `${API}/applications/${appId}/assessments`, {})).json.assessment;
        const dirty = { entries: [{ at: new Date().toISOString(), source: "scanner:zap", method: "GET", host: "127.0.0.1", path: `/reset/${TOKEN}?next=1`, verdict: "allowed", status: 200, extra: "x" } as unknown as EgressEntry], totals: { "scanner:zap": { total: 9, allowed: 9, refused: 0, failed: 0, byMethod: { GET: 9 } } } };
        savePlatformRequests(platform.db, other, "steps", dirty);
        const kept = requestLogOfAssessment(platform.db, other.id);
        expect(kept.entries.map((e) => e.source)).toEqual(["platform:checks"]);
        expect(JSON.stringify(kept)).not.toContain(TOKEN);
        expect(kept.entries[0]!.path).not.toContain("?");
        expect(Object.keys(kept.totals)).toEqual([]);
        expect("extra" in kept.entries[0]!).toBe(false);
        stopAndForget(other.id);
    });

    it("saving a part again replaces it, and the log goes when the assessment is deleted", () => {
        const before = requestLogOfAssessment(platform.db, run.id);
        const one = new RequestLog();
        one.note("platform:cross-account", "GET", `${ORIGIN}/api/notes/1`, "refused", "Out of scope.");
        savePlatformRequests(platform.db, run, "cross-account", one.stored());
        const after = requestLogOfAssessment(platform.db, run.id);
        expect(after.totals["platform:cross-account"]).toMatchObject({ total: 1, refused: 1 });
        expect(after.totals["platform:discovery"]).toEqual(before.totals["platform:discovery"]);
        expect(platform.db.all("SELECT id FROM security_scan_runs WHERE assessment_id = ? AND scanner = 'platform'", run.id)).toHaveLength(2);
        platform.db.run("DELETE FROM security_assessments WHERE id = ?", run.id);
        expect(platform.db.all("SELECT id FROM security_scan_runs WHERE assessment_id = ?", run.id)).toEqual([]);
        expect(requestLogOfAssessment(platform.db, run.id).entries).toEqual([]);
    });
});

const stopAndForget = (id: string) => platform.db.run("DELETE FROM security_assessments WHERE id = ?", id);

describe("the cap is per source", () => {
    it("a busy source keeps its own share and takes none of another's; totals still count everything", () => {
        const log = new RequestLog();
        for (let i = 0; i < MAX_PER_SOURCE + 500; i++) log.note("platform:discovery", "GET", `${ORIGIN}/p/${i}`, "allowed");
        for (let i = 0; i < 3; i++) log.note("platform:cross-account", "GET", `${ORIGIN}/late/${i}`, "allowed");
        const stored = log.stored();
        expect(stored.entries.filter((e) => e.source === "platform:discovery")).toHaveLength(MAX_PER_SOURCE);
        expect(stored.entries.filter((e) => e.source === "platform:cross-account")).toHaveLength(3);
        expect(stored.totals["platform:discovery"]!.total).toBe(MAX_PER_SOURCE + 500);
        // Merged with a scanner's full log: each still has its share.
        const scanner = { entries: Array.from({ length: MAX_PER_SOURCE }, (_, i) => ({ at: new Date(i).toISOString(), source: "scanner:nuclei", method: "GET", host: "h", path: `/s/${i}`, verdict: "allowed" as const })), totals: { "scanner:nuclei": { total: MAX_PER_SOURCE + 7, allowed: MAX_PER_SOURCE + 7, refused: 0, failed: 0, byMethod: { GET: MAX_PER_SOURCE + 7 } } } };
        const merged = mergeRequestLogs([stored, scanner, stored]);
        expect(merged.entries.filter((e) => e.source === "scanner:nuclei")).toHaveLength(MAX_PER_SOURCE);
        expect(merged.entries.filter((e) => e.source === "platform:discovery")).toHaveLength(MAX_PER_SOURCE);
        expect(merged.entries.filter((e) => e.source === "platform:cross-account")).toHaveLength(6);
        expect(merged.totals["platform:discovery"]!.total).toBe(2 * (MAX_PER_SOURCE + 500));
        expect(merged.totals["scanner:nuclei"]!.total).toBe(MAX_PER_SOURCE + 7);
    });
});

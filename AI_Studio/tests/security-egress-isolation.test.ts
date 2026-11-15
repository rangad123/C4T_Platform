/**
 * OS-level egress isolation for scans above passive (src/security/egress/isolation.ts) and how the scanner orchestration and the start
 * gate enforce it. No real scanner: a fake scanner PROCESS started through the platform's own runProcess tries the guard and a direct
 * connection; a local target logs every request and whether it came through the guard. The "isolation proven" case uses this machine's
 * own user and network namespaces and is skipped where they are not available. Ports 9716-9719.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressEnv } from "../src/security/egress/guard.js";
import { detectIsolation, detectIsolationAsync, egressIsolationProblem, ISOLATION_STILL_CHECKING, isolationFor, isolationSupport, proveIsolation, resetIsolationSupport, warmIsolation, type IsolationSupport } from "../src/security/egress/isolation.js";
import { isolationAdapterProblem, runScanners } from "../src/security/scanners/orchestration/run.js";
import { runProcess } from "../src/security/scanners/process.js";
import type { ScannerAdapter, ScanResultSet, ScanTarget } from "../src/security/scanners/contract.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { setProjectScanners } from "../src/security/scanners/store.js";
import { ZapAdapter } from "../src/security/scanners/zap/adapter.js";
import { NucleiAdapter } from "../src/security/scanners/nuclei/adapter.js";
import { GATE_WORDS, startRefusal, type ProfileApproval } from "../src/security/profile-gate.js";
import { SecurityStore } from "../src/security/store.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";

const TARGET_PORT = 9716;
const T = `http://127.0.0.1:${TARGET_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-isolation-"));
const received: Array<{ method: string; path: string; via: boolean }> = [];
let server: http.Server;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        received.push({ method: String(req.method), path: String(req.url), via: String(req.headers.via ?? "").includes("c4t-request-guard") });
        req.resume();
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(req.method === "HEAD" ? undefined : "ok");
    });
    await new Promise<void>((r) => server.listen(TARGET_PORT, "127.0.0.1", () => r()));
});
afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
});

const FAKE_SCANNER = `
const http = require("node:http");
const proxy = new URL(process.env.HTTP_PROXY);
const T = process.env.FAKE_TARGET;
const viaGuard = (method, url) => new Promise((res) => {
  const r = http.request({ host: proxy.hostname, port: proxy.port, method, path: url }, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); });
  r.on("error", (e) => res("error " + e.code)); r.end();
});
const direct = (url) => new Promise((res) => { http.get(url, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); }).on("error", (e) => res("error " + e.code)); });
(async () => {
  const out = { GET: await viaGuard("GET", T + "/api/books"), POST: await viaGuard("POST", T + "/api/books"), direct: await direct(T + "/direct") };
  process.stdout.write(JSON.stringify(out) + "\\n");
})();
`;
const scannerFile = path.join(tmp, "fake-scanner.cjs");
fs.writeFileSync(scannerFile, FAKE_SCANNER);

/** A fake adapter whose tool is a real child process; with `isolated` it starts the tool the way an isolation-ready adapter must. */
function processAdapter(seen: { target?: ScanTarget; out?: Record<string, unknown> }, isolated: boolean): ScannerAdapter {
    return {
        id: "nuclei",
        name: "Fake scanner",
        documentationUrl: "https://example.com",
        description: "fake",
        capabilities: { progress: false, cancel: false, sharedDaemon: false, specDriven: false, aiDriven: false, egressProxy: true, ...(isolated ? { egressIsolation: true } : {}) } as ScannerAdapter["capabilities"],
        available: async () => ({ scanner: "nuclei", state: "available", checkedAt: new Date().toISOString() }),
        validateConfig: async () => ({ ok: true, problems: [], checked: [] }),
        supports: () => true,
        validateScope: async (t) => ({ ok: true, allowed: t.urls, refused: [] }),
        async start(target) {
            seen.target = target;
            const iso = isolationFor(target);
            const cmd = iso ? iso.wrap(process.execPath, [scannerFile]) : { file: process.execPath, args: [scannerFile], cwd: tmp };
            const outcome = await runProcess({ file: cmd.file, args: cmd.args, cwd: cmd.cwd, env: { ...egressEnv(target.egress!.proxyUrl), FAKE_TARGET: T }, timeoutMs: 30_000 });
            seen.out = JSON.parse(outcome.stdout.trim() || "{}") as Record<string, unknown>;
            const results: ScanResultSet = { findings: [], coverage: { inspected: ["looked"], notInspected: [] }, reference: "fake-1" };
            return { scanner: "nuclei", reference: "fake-1", progress: async () => ({ percent: 100, message: "", done: true }), cancel: async () => undefined, results: async () => results, cleanup: async () => undefined };
        },
    };
}

function withDb() {
    const dir = fs.mkdtempSync(path.join(tmp, "db-"));
    const db = new Db(path.join(dir, "t.db"));
    const repo = new Repo(db, new SecretBox(dir));
    const projectId = repo.createProject({ name: "Client A" }).id;
    const store = new SecurityStore(db);
    const application = store.createApplication(projectId, { name: "Shop", targetUrl: `${T}/`, environment: "staging", scope: [], excludedPaths: ["/admin"], maxRequestsPerSecond: 10 });
    const authorization = store.addAuthorization(application.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm I am authorized to test this application.", confirmedByName: "Tester" });
    const assessment = store.createAssessment({ applicationId: application.id, authorizationId: authorization.id, startedBy: "Tester" });
    setProjectScanners(db, projectId, ["nuclei"]);
    return { db, application, assessmentId: assessment.id };
}
const settings = scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_SCANNER_MAX_RPS: "50", SECURITY_SCANNER_REQUEST_BUDGET: "500" });
const approval = { profile: "conservative-active" as const, approvedByUserId: "u1", approvedByName: "Admin", approvedAt: "2026-01-01T00:00:00.000Z", environment: "staging", statement: "approved" };
const active = (adapters: ScannerAdapter[], isolation?: IsolationSupport) => {
    const { db, application, assessmentId } = withDb();
    const run = () =>
        runScanners({ db, application, assessmentId, profile: "conservative-active", approval, signal: new AbortController().signal, target: { urls: [`${T}/`], origin: T }, settings, adapters, egress: { allowPrivate: true, port: 9717, ...(isolation ? { isolation } : {}) } });
    return { db, run };
};
const machine = detectIsolation();

describe("the first isolation check does not block the event loop", () => {
    it("worked out in the background at startup: meanwhile the answer is 'not yet' (fail closed), never a synchronous check", async () => {
        resetIsolationSupport();
        let finish!: (s: IsolationSupport) => void;
        const warm = warmIsolation(() => new Promise((r) => (finish = r)));
        const started = Date.now();
        const meanwhile = isolationSupport();
        expect(Date.now() - started).toBeLessThan(200);
        expect(meanwhile).toEqual({ ok: false, missing: ISOLATION_STILL_CHECKING });
        expect(egressIsolationProblem()).toMatch(/still running after the platform started/);
        finish({ ok: false, missing: "the ip command (iproute2)" });
        expect(await warm).toEqual({ ok: false, missing: "the ip command (iproute2)" });
        expect(isolationSupport()).toEqual({ ok: false, missing: "the ip command (iproute2)" });
        // A check that throws is an answer too: not available, in plain words.
        resetIsolationSupport();
        expect(await warmIsolation(() => Promise.reject(new Error("spawn EAGAIN")))).toEqual({ ok: false, missing: "a working isolation check (spawn EAGAIN)" });
        resetIsolationSupport();
    });

    it.skipIf(!machine.ok)("the asynchronous check gives the synchronous check's answer while the event loop keeps running", async () => {
        let ticks = 0;
        const timer = setInterval(() => ticks++, 10);
        const started = Date.now();
        try {
            const support = await detectIsolationAsync();
            const took = Date.now() - started;
            expect(support.ok, JSON.stringify(support)).toBe(true);
            expect(support.ok && support.mechanism).toBe(machine.ok && machine.mechanism);
            // A blocked loop would not have ticked at all while the checks ran.
            expect(ticks).toBeGreaterThan(Math.floor(took / 10 / 4));
        } finally {
            clearInterval(timer);
        }
    });
});

describe("isolation unavailable: every scan above passive is refused", () => {
    it("names what is missing: not Linux, no unshare/ip, or no permission for a network namespace", () => {
        const win = detectIsolation({ platform: "win32" });
        expect(win.ok).toBe(false);
        expect(egressIsolationProblem(win)).toMatch(/isolated network.*missing network namespaces.*Only passive assessments can start/);
        // A machine whose unshare refuses (user namespaces blocked): fake tools first on PATH.
        const bin = fs.mkdtempSync(path.join(tmp, "bin-"));
        fs.writeFileSync(path.join(bin, "unshare"), "#!/bin/sh\necho 'unshare: write failed /proc/self/uid_map: Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });
        fs.writeFileSync(path.join(bin, "ip"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const blocked = detectIsolation({ searchPath: bin, platform: "linux" });
        expect(blocked.ok).toBe(false);
        expect(egressIsolationProblem(blocked)).toMatch(/permission for this user to create a network namespace.*Operation not permitted/);
    });

    it("the start gate refuses with that sentence once the server switch is on (the switch is told first); passive is never asked", () => {
        const problem = egressIsolationProblem({ ok: false, missing: "the unshare command (util-linux)" })!;
        const a = { id: "a", applicationId: "x", profile: "conservative-active", environment: "staging", approvedByUserId: "u", approvedByName: "A", approvedAt: new Date().toISOString(), statement: "s", withdrawnAt: null, withdrawnBy: null, detailsFingerprint: "f", expiresAt: "2999-01-01T00:00:00.000Z" } as ProfileApproval;
        const base = { kind: "conservative-active" as const, environment: "staging", authorizationMaxProfile: "advanced" as const, approval: a, crowd4testOn: true };
        expect(startRefusal({ ...base, activeProfilesOn: false, egressIsolationProblem: problem })).toBe(GATE_WORDS.switchedOff);
        expect(startRefusal({ ...base, activeProfilesOn: true, egressIsolationProblem: problem })).toBe(problem);
        expect(startRefusal({ ...base, activeProfilesOn: false })).toBe(GATE_WORDS.switchedOff);
        expect(startRefusal({ ...base, kind: "passive", activeProfilesOn: false, egressIsolationProblem: problem })).toBeUndefined();
    });

    it("runScanners refuses every scanner without starting any tool, and the target receives nothing", async () => {
        const seen: { target?: ScanTarget } = {};
        const { db, run } = active([processAdapter(seen, true)], { ok: false, missing: "the ip command (iproute2)" });
        received.length = 0;
        const out = await run();
        expect(seen.target).toBeUndefined();
        expect(out.outcomes.map((o) => o.state)).toEqual(["FAILED"]);
        expect(out.outcomes[0]!.reason).toMatch(/missing the ip command \(iproute2\)/);
        expect(received).toEqual([]);
        db.close();
    });
});

describe("a probe that reaches the target directly: refused", () => {
    it("an 'isolation' that leaves the network open fails the proof, and no scanner starts", async () => {
        // Runs the probe on this machine's own network: the direct connection to the target succeeds.
        const open: IsolationSupport = { ok: true, mechanism: "nothing", wrap: (file, args) => ({ file, args: [...args] }) };
        const proof = await proveIsolation(open, { app: { targetUrl: `${T}/`, scope: [], excludedPaths: [], maxRequestsPerSecond: 10 }, origin: T, allowPrivate: true, port: 9717 });
        expect(proof.ok).toBe(false);
        expect(!proof.ok && proof.reason).toMatch(/reached the target directly \(127\.0\.0\.1\).*refused unless/);

        const seen: { target?: ScanTarget } = {};
        const { db, run } = active([processAdapter(seen, true)], open);
        received.length = 0;
        const out = await run();
        expect(seen.target).toBeUndefined();
        expect(out.outcomes[0]!.state).toBe("FAILED");
        expect(out.outcomes[0]!.reason).toMatch(/reached the target directly/);
        // The probe only opened a connection; nothing was requested of the target.
        expect(received).toEqual([]);
        db.close();
    });

    it("ZAP (a separate service) and an adapter that does not start its tool isolated are refused above passive", () => {
        expect(isolationAdapterProblem(new ZapAdapter({ settings: scannerSettings({}) }))).toMatch(/separate service.*cannot be placed in the isolated network/);
        expect(isolationAdapterProblem(processAdapter({}, false))).toMatch(/does not yet start its tool inside the isolated network/);
        // Nuclei now starts its tool inside the isolated network, so it is no longer refused for that.
        expect(isolationAdapterProblem(new NucleiAdapter({ settings: scannerSettings({}) }))).toBeUndefined();
        expect(isolationAdapterProblem(processAdapter({}, true))).toBeUndefined();
    });
});

describe.skipIf(!machine.ok)("isolation proven on this machine (user network namespace)", () => {
    it("passes the isolation step: the tool reaches the target only through the guard, its direct attempt fails", async () => {
        const seen: { target?: ScanTarget; out?: Record<string, unknown> } = {};
        const { db, run } = active([processAdapter(seen, true)], machine);
        received.length = 0;
        const out = await run();
        expect(out.outcomes.map((o) => o.state)).toEqual(["COMPLETED"]);
        expect(seen.out).toMatchObject({ GET: 200, POST: 405 });
        expect(String(seen.out?.direct)).toMatch(/^error E(NETUNREACH|CONNREFUSED)$/);
        // Everything the target saw came through the guard: the proof's HEAD and the tool's GET. No direct request.
        expect(received.map((r) => `${r.method} ${r.path} ${r.via}`)).toEqual(["HEAD / true", "GET /api/books true"]);
        expect(out.outcomes[0]!.coverage.inspected.join(" ")).toMatch(/Network isolation: .*direct connection to the target \(127\.0\.0\.1\) failed/);
        db.close();
    });

    it("an adapter that does not start its tool isolated is refused even when isolation is available", async () => {
        const seen: { target?: ScanTarget } = {};
        const { db, run } = active([processAdapter(seen, false)], machine);
        const out = await run();
        expect(seen.target).toBeUndefined();
        expect(out.outcomes[0]!.reason).toMatch(/does not yet start its tool inside the isolated network/);
        db.close();
    });
});

/**
 * The isolated scanner environment hides this machine's /run, /tmp, /var/tmp and /dev/shm (src/security/egress/isolation.ts): a network
 * namespace alone leaves file-backed Unix sockets reachable (the name resolver, docker, D-Bus, another run's request guard). Everything
 * here runs in this machine's REAL namespaces through the platform's own wrap and runProcess; it is skipped only where they are not
 * available. The "before" cases use the old mechanism (network namespace only) and must be refused, naming the failed check.
 * Ports 9718-9719.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressEnv } from "../src/security/egress/guard.js";
import { checkEnvironment, detectIsolation, egressIsolationProblem, hostSockets, isolationFor, proveIsolation, startIsolatedEgress, type IsolationSupport } from "../src/security/egress/isolation.js";
import { runScanners } from "../src/security/scanners/orchestration/run.js";
import { runProcess } from "../src/security/scanners/process.js";
import type { ScannerAdapter, ScanTarget } from "../src/security/scanners/contract.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { setProjectScanners } from "../src/security/scanners/store.js";
import { GATE_WORDS, startRefusal, type ProfileApproval } from "../src/security/profile-gate.js";
import { SecurityStore } from "../src/security/store.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";

const TARGET_PORT = 9718;
const RELAY_PORT = 9719;
const T = `http://127.0.0.1:${TARGET_PORT}`;
const app = { targetUrl: `${T}/`, scope: [], excludedPaths: [], maxRequestsPerSecond: 10 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-masking-"));
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

const RESOLVER = "/run/systemd/resolve/io.systemd.Resolve";

/** What a scanner could try: list the hidden folders, open sockets, ask the machine's resolver, go direct, go through the guard. */
const SNOOP = `
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const c = JSON.parse(process.argv[2]);
const unix = (p) => new Promise((res) => { const s = net.connect(p); s.on("connect", () => { s.destroy(); res("connected"); }); s.on("error", (e) => res(e.code)); });
const varlink = () => new Promise((res) => {
  const s = net.connect(${JSON.stringify(RESOLVER)}); let b = "";
  s.on("connect", () => s.write(JSON.stringify({ method: "io.systemd.Resolve.ResolveHostname", parameters: { name: "_localdnsstub" } }) + "\\0"));
  s.on("data", (d) => { b += d; if (b.includes("\\0")) { s.destroy(); res("resolved"); } });
  s.on("error", (e) => res(e.code));
  setTimeout(() => res("timeout"), 3000);
});
const direct = () => new Promise((res) => { http.get(c.target + "/direct", (x) => { x.resume(); x.on("end", () => res(x.statusCode)); }).on("error", (e) => res("error " + e.code)); });
const viaGuard = () => new Promise((res) => {
  const proxy = new URL(process.env.HTTP_PROXY);
  const r = http.request({ host: proxy.hostname, port: proxy.port, method: "GET", path: c.target + "/via" }, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); });
  r.on("error", (e) => res("error " + e.code)); r.end();
});
const list = (p) => { try { return fs.readdirSync(p); } catch (e) { return e.code; } };
(async () => {
  const out = { ls: {}, sockets: {}, cwd: list(".") };
  for (const p of ["/run", "/tmp", "/var/tmp", "/dev/shm"]) out.ls[p] = list(p);
  for (const p of c.sockets) out.sockets[p] = await unix(p);
  out.varlink = await varlink();
  out.direct = await direct();
  out.viaGuard = await viaGuard();
  process.stdout.write(JSON.stringify(out) + "\\n");
})();
`;
const snoopFile = path.join(tmp, "snoop.cjs");
fs.writeFileSync(snoopFile, SNOOP);
type Snoop = { ls: Record<string, string[] | string>; sockets: Record<string, string>; cwd: string[] | string; varlink: string; direct: unknown; viaGuard: unknown };

const machine = detectIsolation();

/** The mechanism before the fix: a user and network namespace only, nothing hidden. Must be refused. */
const LEGACY_RELAY = `
const { execFileSync, spawn } = require("node:child_process");
const net = require("node:net");
const [sock, port, file, ...args] = process.argv.slice(1);
execFileSync("ip", ["link", "set", "lo", "up"], { stdio: "ignore" });
const server = net.createServer((c) => { const u = net.connect(sock); const end = () => { c.destroy(); u.destroy(); }; c.on("error", end); u.on("error", end); c.on("close", end); u.on("close", end); c.pipe(u).pipe(c); });
server.listen(Number(port), "127.0.0.1", () => { const child = spawn(file, args, { stdio: "inherit" }); child.on("exit", (code) => process.exit(code ?? 1)); });
`;
const legacy: IsolationSupport = {
    ok: true,
    mechanism: "a network namespace with nothing hidden",
    wrap: (file, args, relay) => ({ file: "unshare", args: ["-rn", "--", process.execPath, "-e", LEGACY_RELAY, relay.socketPath, String(relay.port), file, ...args] }),
};

const hostHas = (p: string) => {
    try {
        return fs.statSync(p).isSocket();
    } catch {
        return false;
    }
};

describe.skipIf(!machine.ok)("the real isolated environment on this machine", () => {
    it("hides /run, /tmp, /var/tmp and /dev/shm; host sockets, the host resolver and a second concurrent run's guard are unreachable; direct fails; the guard works", async () => {
        if (!machine.ok) return;
        const a = await startIsolatedEgress(machine, { app, allowPrivate: true, maxRequests: 10, port: RELAY_PORT });
        const b = await startIsolatedEgress(machine, { app, allowPrivate: true, maxRequests: 10, port: RELAY_PORT });
        try {
            const sockets = [...hostSockets(), path.join(a.socketDir, "guard.sock"), path.join(b.socketDir, "guard.sock")];
            const snoop = async (iso: typeof a, cwd?: string) => {
                const cmd = iso.wrap(process.execPath, [snoopFile, JSON.stringify({ target: T, sockets })]);
                const ran = await runProcess({ file: cmd.file, args: cmd.args, cwd: cwd ?? cmd.cwd, env: egressEnv(iso.guard.url), timeoutMs: 30_000 });
                expect(ran.stderr).toBe("");
                return JSON.parse(ran.stdout.trim()) as Snoop;
            };
            received.length = 0;
            // Both runs at the same time: each in its own environment.
            const [fromA, fromB] = await Promise.all([snoop(a), snoop(b)]);
            for (const [seen, own, other] of [[fromA, a, b], [fromB, b, a]] as const) {
                expect(seen.ls["/run"]).toEqual([]);
                expect(seen.ls["/var/tmp"]).toEqual([]);
                expect(seen.ls["/dev/shm"]).toEqual([]);
                // /tmp shows only what leads to this run's own folders: its guard folder, the tool's folder, Node's folder.
                const mine = [own.socketDir, tmp, path.dirname(fs.realpathSync(process.execPath))].filter((p) => p.startsWith("/tmp/")).map((p) => p.split("/")[2]!);
                expect([...(seen.ls["/tmp"] as string[])].sort()).toEqual([...new Set(mine)].sort());
                expect(seen.ls["/tmp"]).not.toContain(path.basename(other.socketDir));
                // Its own guard socket is there (through the bound-in folder); the other run's is not.
                expect(seen.sockets[path.join(own.socketDir, "guard.sock")]).toBe("connected");
                expect(seen.sockets[path.join(other.socketDir, "guard.sock")]).toBe("ENOENT");
                for (const s of hostSockets()) expect(seen.sockets[s], s).not.toBe("connected");
                expect(seen.varlink).not.toBe("resolved");
                expect(String(seen.direct)).toMatch(/^error E(NETUNREACH|CONNREFUSED)$/);
                expect(seen.viaGuard).toBe(200);
            }
            // These sockets do exist on this machine wherever the test means anything: say so, so an all-ENOENT pass is not vacuous.
            if (hostHas(RESOLVER)) expect(fromA.sockets[RESOLVER]).toBe("ENOENT");
            expect(received.map((r) => `${r.method} ${r.path} ${r.via}`).sort()).toEqual(["GET /via true", "GET /via true"]);
            // No leftovers of the staging in the run's own folder.
            expect(fs.readdirSync(a.socketDir)).toEqual(["guard.sock"]);

            // Started with the shared /tmp as working directory: the tool gets the empty private /tmp, not a handle on the real one.
            const fromTmp = await snoop(a, "/tmp");
            expect(fromTmp.cwd).toEqual(fromTmp.ls["/tmp"]);
            expect(fromTmp.cwd).not.toContain(path.basename(b.socketDir));
        } finally {
            await a.close();
            await b.close();
        }
    });

    it("a folder that holds other runs' guard folders is never bound back in, even when the command line names it", async () => {
        if (!machine.ok) return;
        const a = await startIsolatedEgress(machine, { app, allowPrivate: true, maxRequests: 10, port: RELAY_PORT });
        const b = await startIsolatedEgress(machine, { app, allowPrivate: true, maxRequests: 10, port: RELAY_PORT });
        try {
            const other = path.join(b.socketDir, "guard.sock");
            // os.tmpdir() (the parent of every guard folder) and the other run's folder itself on the command line.
            const cmd = a.wrap(process.execPath, [snoopFile, JSON.stringify({ target: T, sockets: [other] }), os.tmpdir(), "/run/systemd/resolve"]);
            const ran = await runProcess({ file: cmd.file, args: cmd.args, cwd: cmd.cwd, env: egressEnv(a.guard.url), timeoutMs: 30_000 });
            const seen = JSON.parse(ran.stdout.trim()) as Snoop;
            expect(seen.sockets[other]).toBe("ENOENT");
            expect(seen.ls["/run"]).toEqual([]);
            expect(seen.ls["/tmp"]).not.toContain(path.basename(b.socketDir));
        } finally {
            await a.close();
            await b.close();
        }
    });

    it("the proof passes here and says what it checked", async () => {
        // os.tmpdir() is shared with other test files (and their background checks): only this test's runs are judged for leftovers.
        const guardFolders = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("c4t-egress-"));
        const before = new Set(guardFolders());
        received.length = 0;
        const proof = await proveIsolation(machine, { app, origin: T, allowPrivate: true, port: RELAY_PORT });
        expect(proof).toMatchObject({ ok: true });
        expect(proof.ok && proof.line).toMatch(/unshare -rn -m.*direct connection to the target \(127\.0\.0\.1\) failed.*\/run, \/tmp, \/var\/tmp and \/dev\/shm were private and empty.*none of this machine's sockets nor another run's request guard could be opened.*no name could be looked up.*through the request guard arrived/);
        expect(received.map((r) => `${r.method} ${r.path} ${r.via}`)).toEqual(["HEAD / true"]);
        if (machine.ok) expect(checkEnvironment(machine)).toBeUndefined();
        // Nothing left behind in the temporary folder.
        expect(guardFolders().filter((f) => !before.has(f))).toEqual([]);
    });
});

describe.skipIf(!machine.ok)("fail closed: a network namespace that hides nothing (the mechanism before this fix) is refused", () => {
    it("the proof refuses, naming the failed check, though direct traffic is blocked and the guard works", async () => {
        received.length = 0;
        const proof = await proveIsolation(legacy, { app, origin: T, allowPrivate: true, port: RELAY_PORT });
        expect(proof.ok).toBe(false);
        expect(!proof.ok && proof.reason).toMatch(/^The external scanners were not run: \/run in the scanners' environment is still this machine's own \/run, so a scanner could reach this machine's sockets or files and go round the request guard\. Scans above passive are refused/);
    });

    it("a scanner that keeps the namespace's capabilities could unmount the masking: the environment check tries it and refuses", () => {
        if (!machine.ok) return;
        // The current mechanism, except that the scanner is started WITH its capabilities: a stand-in for setpriv that drops nothing.
        // It lives outside the masked folders, so the relay can still start it after hiding /tmp.
        const keepDir = fs.mkdtempSync(path.join(process.cwd(), ".test-keepcaps-"));
        try {
            const keep = path.join(keepDir, "keep-caps");
            fs.writeFileSync(keep, '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
            const real = machine.wrap("/x", [], { socketPath: "/s", port: 1 });
            const setpriv = real.args[real.args.indexOf("/s") - 1]!;
            expect(path.basename(setpriv)).toBe("setpriv");
            const withCaps: IsolationSupport = { ...machine, wrap: (file, args, relay) => { const w = machine.wrap(file, args, relay); return { ...w, args: w.args.map((x) => (x === setpriv ? keep : x)) }; } };
            expect(checkEnvironment(withCaps as Extract<IsolationSupport, { ok: true }>)).toBe("/run could be unmounted from the scanners' environment, which shows this machine's own /run again");
            // The real mechanism refuses the unmount, so it passes.
            expect(checkEnvironment(machine)).toBeUndefined();
        } finally {
            fs.rmSync(keepDir, { recursive: true, force: true });
        }
    });

    it("the environment check behind the start gate names it too, and the start gate refuses with that sentence", () => {
        if (!legacy.ok) return;
        const problem = checkEnvironment(legacy);
        expect(problem).toBe("/run in the scanners' environment is still this machine's own /run");
        const sentence = egressIsolationProblem({ ok: false, missing: `a private environment for the scanners (${problem})` })!;
        expect(sentence).toMatch(/this machine cannot provide one: it is missing a private environment for the scanners \(\/run in the scanners' environment is still this machine's own \/run\)\. Only passive assessments can start\./);
        const approval = { id: "a", applicationId: "x", profile: "conservative-active", environment: "staging", approvedByUserId: "u", approvedByName: "A", approvedAt: new Date().toISOString(), statement: "s", withdrawnAt: null, withdrawnBy: null, detailsFingerprint: "f", expiresAt: "2999-01-01T00:00:00.000Z" } as ProfileApproval;
        const base = { kind: "conservative-active" as const, environment: "staging", authorizationMaxProfile: "advanced" as const, approval, crowd4testOn: true };
        expect(startRefusal({ ...base, activeProfilesOn: true, egressIsolationProblem: sentence })).toBe(sentence);
        // The switch still comes first, and stays off by default.
        expect(startRefusal({ ...base, activeProfilesOn: false, egressIsolationProblem: sentence })).toBe(GATE_WORDS.switchedOff);
    });

    it("runScanners starts no scanner and records the sentence", async () => {
        const dir = fs.mkdtempSync(path.join(tmp, "db-"));
        const db = new Db(path.join(dir, "t.db"));
        const repo = new Repo(db, new SecretBox(dir));
        const projectId = repo.createProject({ name: "Client A" }).id;
        const store = new SecurityStore(db);
        const application = store.createApplication(projectId, { name: "Shop", targetUrl: `${T}/`, environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 10 });
        const authorization = store.addAuthorization(application.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm I am authorized to test this application.", confirmedByName: "Tester" });
        const assessment = store.createAssessment({ applicationId: application.id, authorizationId: authorization.id, startedBy: "Tester" });
        setProjectScanners(db, projectId, ["nuclei"]);
        let started = false;
        const adapter: ScannerAdapter = {
            id: "nuclei",
            name: "Fake scanner",
            documentationUrl: "https://example.com",
            description: "fake",
            capabilities: { progress: false, cancel: false, sharedDaemon: false, specDriven: false, aiDriven: false, egressProxy: true, egressIsolation: true } as ScannerAdapter["capabilities"],
            available: async () => ({ scanner: "nuclei", state: "available", checkedAt: new Date().toISOString() }),
            validateConfig: async () => ({ ok: true, problems: [], checked: [] }),
            supports: () => true,
            validateScope: async (t: ScanTarget) => ({ ok: true, allowed: t.urls, refused: [] }),
            async start(target) {
                started = true;
                void isolationFor(target);
                throw new Error("must not start");
            },
        };
        received.length = 0;
        const out = await runScanners({
            db,
            application,
            assessmentId: assessment.id,
            profile: "conservative-active",
            approval: { profile: "conservative-active" as const, approvedByUserId: "u1", approvedByName: "Admin", approvedAt: "2026-01-01T00:00:00.000Z", environment: "staging", statement: "approved" },
            signal: new AbortController().signal,
            target: { urls: [`${T}/`], origin: T },
            settings: scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_SCANNER_MAX_RPS: "50", SECURITY_SCANNER_REQUEST_BUDGET: "500" }),
            adapters: [adapter],
            egress: { allowPrivate: true, port: RELAY_PORT, isolation: legacy },
        });
        expect(started).toBe(false);
        expect(out.outcomes.map((o) => o.state)).toEqual(["FAILED"]);
        expect(out.outcomes[0]!.reason).toMatch(/\/run in the scanners' environment is still this machine's own \/run/);
        // Only the proof's own HEAD through the guard reached the target; no scanner request.
        expect(received.filter((r) => !r.via)).toEqual([]);
        expect(received.filter((r) => r.method !== "HEAD")).toEqual([]);
        db.close();
    });
});

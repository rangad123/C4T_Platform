/**
 * Nuclei and Schemathesis started inside the isolated network that scans above passive need (src/security/egress/isolation.ts), and the
 * Schemathesis base-path fix. No real scanner: a fake tool PROCESS stands in for both binaries, run by the real adapters through the
 * platform's own runProcess. Under the real user network namespace (skipped where this machine cannot create one) the fake tool's
 * direct connection to the target must fail, its request through the guard must arrive, and a cancel must kill the tool and the helper
 * it started. Ports 9800-9809.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectIsolation, setIsolationFor, startIsolatedEgress, type IsolatedEgress } from "../src/security/egress/isolation.js";
import { isolationAdapterProblem, runScanners } from "../src/security/scanners/orchestration/run.js";
import type { ScanTarget } from "../src/security/scanners/contract.js";
import { runProcess, type RunOptions } from "../src/security/scanners/process.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { setProjectScanners } from "../src/security/scanners/store.js";
import { NucleiAdapter } from "../src/security/scanners/nuclei/adapter.js";
import { apiBaseUrl, rewriteServers, SchemathesisAdapter } from "../src/security/scanners/schemathesis/adapter.js";
import { SecurityStore } from "../src/security/store.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";

const TARGET_PORT = 9800;
const T = `http://127.0.0.1:${TARGET_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-scanner-isolation-"));
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

// One fake tool for both adapters: it answers the version probe, then tries the target through the guard and directly, writes what it
// saw to OUT, and (for Schemathesis) writes one tested scenario to the NDJSON report. With the HANG file present it starts a helper
// process and waits forever, ignoring SIGTERM, writing both process ids first.
const OUT = path.join(tmp, "out.json");
const HANG = path.join(tmp, "hang");
const PIDS = path.join(tmp, "pids.json");
const FAKE_TOOL = `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes("-version")) { process.stdout.write("Nuclei Engine Version: v3.3.0\\n"); process.exit(0); }
if (argv.includes("--version")) { process.stdout.write("schemathesis, version 4.32.4\\n"); process.exit(0); }
if (fs.existsSync(${JSON.stringify(HANG)})) {
  // A tool that ignores the polite stop: only the process-group kill can take it and its helper down.
  process.on("SIGTERM", () => {});
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(PIDS)}, JSON.stringify({ tool: process.pid, helper: helper.pid }));
  setInterval(() => {}, 1000);
  return;
}
const proxy = new URL(flag("-proxy") || flag("--proxy"));
const base = flag("--url") || fs.readFileSync(flag("-l"), "utf8").split("\\n")[0].replace(/\\/+$/, "");
const spec = argv[0] === "run" ? JSON.parse(fs.readFileSync(argv[1], "utf8")) : argv.includes("run") ? JSON.parse(fs.readFileSync(argv[argv.indexOf("run") + 1], "utf8")) : null;
const viaGuard = (url) => new Promise((res) => {
  const r = http.request({ host: proxy.hostname, port: proxy.port, method: "GET", path: url }, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); });
  r.on("error", (e) => res("error " + e.code)); r.end();
});
const direct = (url) => new Promise((res) => { http.get(url, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); }).on("error", (e) => res("error " + e.code)); });
(async () => {
  const out = { base, servers: spec && spec.servers, guarded: await viaGuard(base + "/books"), direct: await direct(${JSON.stringify(T)} + "/direct") };
  fs.writeFileSync(${JSON.stringify(OUT)}, JSON.stringify(out));
  const ndjson = flag("--report-ndjson-path");
  if (ndjson) fs.writeFileSync(ndjson, JSON.stringify({ ScenarioFinished: { phase: "examples", status: "success", recorder: { label: "GET /v1/books" } } }) + "\\n");
})();
`;
const tool = path.join(tmp, "fake-tool");
fs.writeFileSync(tool, FAKE_TOOL, { mode: 0o755 });
const templates = path.join(tmp, "templates");
fs.mkdirSync(templates);
fs.writeFileSync(path.join(templates, "probe.yaml"), "id: fake-probe\ninfo:\n  name: Probe\n  severity: info\n  tags: misconfig\nhttp:\n  - method: GET\n    path:\n      - \"{{BaseURL}}/books\"\n");

const settings = scannerSettings({
    SECURITY_SCANNERS: "nuclei,schemathesis",
    SECURITY_NUCLEI_PATH: tool,
    SECURITY_NUCLEI_TEMPLATES: templates,
    SECURITY_SCHEMATHESIS_PATH: tool,
    SECURITY_SCANNER_MAX_RPS: "50",
    SECURITY_SCANNER_REQUEST_BUDGET: "500",
});
const app = { targetUrl: `${T}/`, scope: [], excludedPaths: [], maxRequestsPerSecond: 10 };
const SPEC = JSON.stringify({ openapi: "3.0.3", info: { title: "Books", version: "1" }, servers: [{ url: "https://elsewhere.example.com/v1" }], paths: { "/books": { get: { responses: { "200": { description: "ok" } } } } } });
const targetFor = (spec: string | null): ScanTarget => ({ applicationId: "app-1", origin: T, urls: [`${T}/`], excludedPaths: [], maxRequestsPerSecond: 10, requestBudget: 100, timeoutMs: 30_000, spec: spec ? { fileName: "api.json", text: spec } : null });
const approval = { profile: "conservative-active" as const, approvedByUserId: "u1", approvedByName: "Admin", approvedAt: "2026-01-01T00:00:00.000Z", environment: "staging", statement: "approved" };
const readOut = () => JSON.parse(fs.readFileSync(OUT, "utf8")) as { base: string; servers: unknown; guarded: unknown; direct: unknown };
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe("Schemathesis keeps the API document's base path", () => {
    it("the rewritten server entry and --url keep /v1, absolute or relative, JSON or YAML, OpenAPI or Swagger 2", () => {
        expect(JSON.parse(rewriteServers(SPEC, T)).servers).toEqual([{ url: `${T}/v1` }]);
        expect(JSON.parse(rewriteServers('{"openapi":"3.0.3","servers":[{"url":"/api/v2/"}]}', T)).servers).toEqual([{ url: `${T}/api/v2` }]);
        expect(JSON.parse(rewriteServers('{"openapi":"3.0.3","servers":[{"url":"https://elsewhere.example.com"}]}', T)).servers).toEqual([{ url: T }]);
        expect(apiBaseUrl(SPEC, T)).toBe(`${T}/v1`);
        expect(apiBaseUrl("swagger: '2.0'\nbasePath: /v1\npaths: {}\n", T)).toBe(`${T}/v1`);
        expect(apiBaseUrl("openapi: 3.0.3\nservers:\n  - url: https://x.example.com/v3\npaths: {}\n", T)).toBe(`${T}/v3`);
        expect(apiBaseUrl('{"openapi":"3.0.3","paths":{}}', T)).toBe(T);
    });

    it("the command Schemathesis is started with carries the base path", async () => {
        const seen: RunOptions[] = [];
        const adapter = new SchemathesisAdapter({
            settings,
            run: async (o) => {
                seen.push(o);
                return { code: 0, signal: null, stopped: false, stopReason: null, stdout: o.args.includes("--version") ? "4.32.4" : "", stderr: "", truncated: false, tookMs: 1 };
            },
            readFile: async () => JSON.stringify({ ScenarioFinished: { status: "success", recorder: { label: "GET /v1/books" } } }),
        });
        const handle = await adapter.start(targetFor(SPEC), "passive", { signal: new AbortController().signal });
        await handle.cleanup();
        const args = seen.at(-1)!.args;
        expect(args[args.indexOf("--url") + 1]).toBe(`${T}/v1`);
    });
});

describe("Nuclei and Schemathesis start their tool inside the isolated network when the run has one", () => {
    it("both declare it, so the orchestration lets them run above passive", () => {
        expect(isolationAdapterProblem(new NucleiAdapter({ settings }))).toBeUndefined();
        expect(isolationAdapterProblem(new SchemathesisAdapter({ settings }))).toBeUndefined();
    });

    it("with an isolated run the tool is started through its wrap; without one (passive) it is started as it is", async () => {
        const ok = (o: RunOptions) => ({ code: 0, signal: null, stopped: false, stopReason: null as null, stdout: o.args.includes("-version") ? "v3.3.0" : o.args.includes("--version") ? "4.32.4" : "", stderr: "", truncated: false, tookMs: 1 });
        const readFile = async () => JSON.stringify({ ScenarioFinished: { status: "success", recorder: { label: "GET /v1/books" } } });
        const fakeIso = { wrap: (file: string, args: readonly string[]) => ({ file: "/isolated/start", args: ["--", file, ...args], cwd: "/" }) } as unknown as IsolatedEgress;
        for (const kind of ["nuclei", "schemathesis"] as const) {
            for (const isolated of [true, false]) {
                const seen: RunOptions[] = [];
                const run = async (o: RunOptions) => (seen.push(o), ok(o));
                const adapter = kind === "nuclei" ? new NucleiAdapter({ settings, run }) : new SchemathesisAdapter({ settings, run, readFile });
                const target = { ...targetFor(kind === "nuclei" ? null : SPEC), egress: { proxyUrl: "http://127.0.0.1:9809" } };
                if (isolated) setIsolationFor(target, fakeIso);
                const handle = await adapter.start(target, "conservative-active", { signal: new AbortController().signal, approval });
                await handle.cleanup();
                const last = seen.at(-1)!;
                if (isolated) {
                    expect(last.file).toBe("/isolated/start");
                    expect(last.args.slice(0, 2)).toEqual(["--", tool]);
                } else expect(last.file).toBe(tool);
                // The tool still runs in its own temporary folder and is still pointed at the guard.
                expect(last.cwd).not.toBe("/");
                expect(last.env?.HTTP_PROXY).toBe("http://127.0.0.1:9809");
            }
        }
    });
});

const machine = detectIsolation();

describe.skipIf(!machine.ok)("under this machine's real user network namespace", () => {
    it("Nuclei through runScanners above passive: direct traffic fails, guarded traffic arrives", async () => {
        const dir = fs.mkdtempSync(path.join(tmp, "db-"));
        const db = new Db(path.join(dir, "t.db"));
        const repo = new Repo(db, new SecretBox(dir));
        const projectId = repo.createProject({ name: "Client A" }).id;
        const store = new SecurityStore(db);
        const application = store.createApplication(projectId, { name: "Shop", targetUrl: `${T}/`, environment: "staging", scope: [], excludedPaths: ["/admin"], maxRequestsPerSecond: 10 });
        const authorization = store.addAuthorization(application.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm I am authorized to test this application.", confirmedByName: "Tester" });
        const assessment = store.createAssessment({ applicationId: application.id, authorizationId: authorization.id, startedBy: "Tester" });
        setProjectScanners(db, projectId, ["nuclei"]);
        fs.rmSync(OUT, { force: true });
        received.length = 0;
        const out = await runScanners({ db, application, assessmentId: assessment.id, profile: "conservative-active", approval, signal: new AbortController().signal, target: { urls: [`${T}/`], origin: T }, settings, adapters: [new NucleiAdapter({ settings })], egress: { allowPrivate: true, port: 9801, isolation: machine } });
        expect(out.outcomes.map((o) => `${o.state} ${o.reason}`)).toEqual(["COMPLETED ProjectDiscovery Nuclei finished."]);
        const seen = readOut();
        expect(seen.guarded).toBe(200);
        expect(String(seen.direct)).toMatch(/^error E(NETUNREACH|CONNREFUSED)$/);
        // Everything the target saw came through the guard: the isolation proof's HEAD and the tool's GET. Nothing direct.
        expect(received.map((r) => `${r.method} ${r.path} ${r.via}`)).toEqual(["HEAD / true", "GET /books true"]);
        expect(out.outcomes[0]!.coverage.inspected.join(" ")).toMatch(/Network isolation: .*direct connection to the target \(127\.0\.0\.1\) failed/);
        db.close();
    });

    it("Schemathesis in an isolated run: direct traffic fails, guarded traffic arrives at the base path", async () => {
        if (!machine.ok) return;
        const iso = await startIsolatedEgress(machine, { app, allowPrivate: true, maxRequests: 10, port: 9802 });
        try {
            const target = { ...targetFor(SPEC), egress: { proxyUrl: iso.guard.url } };
            setIsolationFor(target, iso);
            fs.rmSync(OUT, { force: true });
            received.length = 0;
            const handle = await new SchemathesisAdapter({ settings }).start(target, "conservative-active", { signal: new AbortController().signal, approval });
            const results = await handle.results();
            await handle.cleanup();
            const seen = readOut();
            expect(seen.base).toBe(`${T}/v1`);
            expect(seen.servers).toEqual([{ url: `${T}/v1` }]);
            expect(seen.guarded).toBe(200);
            expect(String(seen.direct)).toMatch(/^error E(NETUNREACH|CONNREFUSED)$/);
            expect(received.map((r) => `${r.method} ${r.path} ${r.via}`)).toEqual(["GET /v1/books true"]);
            expect(iso.guard.counts().total).toBe(1);
            expect(results.coverage.inspected.join(" ")).toMatch(/1 operation/);
        } finally {
            await iso.close();
        }
    });

    it("a cancel of a tool that ignores the polite stop kills it and its helper inside the namespace (process-group kill)", async () => {
        if (!machine.ok) return;
        fs.writeFileSync(HANG, "");
        fs.rmSync(PIDS, { force: true });
        const iso = await startIsolatedEgress(machine, { app, allowPrivate: true, maxRequests: 10, port: 9803 });
        try {
            for (const adapter of [new NucleiAdapter({ settings }), new SchemathesisAdapter({ settings })]) {
                fs.rmSync(PIDS, { force: true });
                const target = { ...targetFor(SPEC), egress: { proxyUrl: iso.guard.url } };
                setIsolationFor(target, iso);
                const controller = new AbortController();
                const started = adapter.start(target, "conservative-active", { signal: controller.signal, approval });
                started.catch(() => undefined);
                const deadline = Date.now() + 15_000;
                while (!fs.existsSync(PIDS) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
                const pids = JSON.parse(fs.readFileSync(PIDS, "utf8")) as { tool: number; helper: number };
                expect(alive(pids.tool) && alive(pids.helper)).toBe(true);
                controller.abort();
                const settled = await started.then(
                    async (h) => (await h.cleanup(), "finished"),
                    (e: Error) => e.message,
                );
                expect(settled).toMatch(/cancelled|stopped/i);
                const gone = Date.now() + 8_000;
                while ((alive(pids.tool) || alive(pids.helper)) && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
                expect([alive(pids.tool), alive(pids.helper)]).toEqual([false, false]);
            }
        } finally {
            fs.rmSync(HANG, { force: true });
            await iso.close();
        }
    });
});

// A tool that exits at once on SIGTERM but leaves a helper (with its own stdio) running: the stop must still take the helper down.
const POLITE = path.join(tmp, "polite-tool.cjs");
const POLITE_PIDS = path.join(tmp, "polite-pids.json");
fs.writeFileSync(
    POLITE,
    `const { spawn } = require("node:child_process");
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(POLITE_PIDS)}, JSON.stringify({ tool: process.pid, helper: helper.pid }));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
);

async function politeStop(wrap: (file: string, args: string[]) => { file: string; args: string[] }) {
    fs.rmSync(POLITE_PIDS, { force: true });
    const controller = new AbortController();
    const cmd = wrap(process.execPath, [POLITE]);
    const running = runProcess({ file: cmd.file, args: cmd.args, cwd: tmp, signal: controller.signal, timeoutMs: 30_000 });
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(POLITE_PIDS) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const pids = JSON.parse(fs.readFileSync(POLITE_PIDS, "utf8")) as { tool: number; helper: number };
    expect(alive(pids.helper)).toBe(true);
    controller.abort();
    const outcome = await running;
    expect(outcome.stopReason).toBe("cancelled");
    const gone = Date.now() + 3_000;
    while ((alive(pids.tool) || alive(pids.helper)) && Date.now() < gone) await new Promise((r) => setTimeout(r, 50));
    expect([alive(pids.tool), alive(pids.helper)]).toEqual([false, false]);
}

describe.skipIf(process.platform === "win32")("a tool that exits on the polite stop leaves no helper running", () => {
    it("started directly", async () => {
        await politeStop((file, args) => ({ file, args }));
    });
    it.skipIf(!machine.ok)("started inside the isolated network", async () => {
        if (!machine.ok) return;
        await politeStop((file, args) => machine.wrap(file, args, { socketPath: path.join(tmp, "unused.sock"), port: 9804 }));
    });
});

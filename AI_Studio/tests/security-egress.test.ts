/**
 * The request guard for external scanners (src/security/egress/guard.ts) and how the scanner orchestration enforces it.
 *
 * No real scanner is used: a fake scanner PROCESS (a small node script started through the platform's own runProcess) tries every
 * method, an off-scope host, an excluded path, an HTTPS tunnel, and a direct request that skips the guard. A local target server logs
 * every request it receives, so "nothing arrives except through the guard" is checked on the target's side. The real adapters' wiring
 * (nuclei and schemathesis proxy flags and environment, ZAP's upstream proxy) is checked through their fake-process and fake-API hooks.
 * Ports 9710-9719.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressEnv, egressTargetProblem, startEgressGuard, type EgressGuard, passesRequestHeader } from "../src/security/egress/guard.js";
import { egressAdapterProblem, runScanners } from "../src/security/scanners/orchestration/run.js";
import { runProcess } from "../src/security/scanners/process.js";
import type { ScannerAdapter, ScanResultSet, ScanTarget } from "../src/security/scanners/contract.js";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { runsOfAssessment, setProjectScanners } from "../src/security/scanners/store.js";
import { NucleiAdapter } from "../src/security/scanners/nuclei/adapter.js";
import { SchemathesisAdapter } from "../src/security/scanners/schemathesis/adapter.js";
import { ZapAdapter } from "../src/security/scanners/zap/adapter.js";
import { PromptfooAdapter } from "../src/security/scanners/promptfoo/adapter.js";
import { SecurityStore } from "../src/security/store.js";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";

const TARGET_PORT = 9711;
const OFF_PORT = 9712;
const BUSY_PORT = 9713;
const T = `http://127.0.0.1:${TARGET_PORT}`;
const OFF = `http://127.0.0.1:${OFF_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-egress-"));

/** Everything the target and the off-scope server received: method, path, and whether it came through the guard (Via header). */
const received: Array<{ server: "target" | "off"; method: string; path: string; via: boolean; headers: http.IncomingHttpHeaders }> = [];
const servers: http.Server[] = [];
const serve = (name: "target" | "off", port: number) =>
    new Promise<void>((resolve) => {
        const s = http.createServer((req, res) => {
            received.push({ server: name, method: String(req.method), path: String(req.url), via: String(req.headers.via ?? "").includes("c4t-request-guard"), headers: req.headers });
            req.resume();
            if (req.url?.startsWith("/moved")) {
                res.writeHead(302, { location: `${OFF}/elsewhere` });
                return res.end();
            }
            if (req.url?.startsWith("/forged")) {
                // An application that tries to speak in the guard's voice.
                res.writeHead(200, { "content-type": "text/plain", "X-C4T-Guard": "refused", "x-c4t-source": "platform:checks", X_C4T_Guard: "failed", "x-site": "kept" });
                return res.end("the site's own words");
            }
            res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] });
            res.end(req.method === "HEAD" ? undefined : `hello ${req.url}`);
        });
        servers.push(s);
        s.listen(port, "127.0.0.1", () => resolve());
    });

beforeAll(async () => {
    await serve("target", TARGET_PORT);
    await serve("off", OFF_PORT);
});
afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
});

const app = { targetUrl: `${T}/`, scope: [] as string[], excludedPaths: ["/admin"], maxRequestsPerSecond: 10 };

/** One request through a proxy in absolute form, the way an HTTP client configured with a proxy sends it. */
function viaProxy(guard: EgressGuard, method: string, url: string, body?: string, extra: Record<string, string> = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const headers = { ...extra, ...(body ? { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) } : {}) };
        const req = http.request({ host: "127.0.0.1", port: guard.port, method, path: url, headers }, (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
        });
        req.on("error", reject);
        req.end(body);
    });
}

describe("the request guard on its own", () => {
    let guard: EgressGuard;
    beforeAll(async () => {
        guard = await startEgressGuard({ app, allowPrivate: true, port: 9714 });
    });
    afterAll(() => guard.close());

    it("forwards GET, HEAD and OPTIONS to in-scope addresses, marked as coming through the guard, cookies intact", async () => {
        received.length = 0;
        const get = await viaProxy(guard, "GET", `${T}/api/books`);
        expect(get.status).toBe(200);
        expect(get.text).toBe("hello /api/books");
        expect(get.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
        expect((await viaProxy(guard, "HEAD", `${T}/`)).status).toBe(200);
        expect((await viaProxy(guard, "OPTIONS", `${T}/`)).status).toBe(200);
        expect(received.map((r) => `${r.method} ${r.path} ${r.via}`)).toEqual(["GET /api/books true", "HEAD / true", "OPTIONS / true"]);
    });

    it("refuses every other method at the guard: nothing reaches the target", async () => {
        received.length = 0;
        for (const m of ["POST", "PUT", "DELETE", "PATCH", "TRACE", "PROPFIND"]) {
            const r = await viaProxy(guard, m, `${T}/api/books`, m === "POST" || m === "PUT" ? "x=1" : undefined);
            expect(r.status, m).toBe(405);
            expect(r.text).toMatch(/Only GET, HEAD and OPTIONS/);
        }
        expect(received).toEqual([]);
    });

    it("refuses off-scope hosts, excluded paths (in any spelling), bodies, HTTPS tunnels and requests not addressed to a proxy", async () => {
        received.length = 0;
        expect((await viaProxy(guard, "GET", `${OFF}/`)).status).toBe(403);
        expect((await viaProxy(guard, "GET", "http://169.254.169.254/latest/meta-data/")).status).toBe(403);
        for (const p of ["/admin", "/admin/users", "/ADMIN/x", "/%61dmin/x", "//admin/x"]) expect((await viaProxy(guard, "GET", `${T}${p}`)).status, p).toBe(403);
        expect((await viaProxy(guard, "GET", `${T}/api/books`, "body")).status).toBe(403);
        expect((await viaProxy(guard, "GET", "/api/books")).status).toBe(403);
        const connect = await new Promise<number>((resolve) => {
            const req = http.request({ host: "127.0.0.1", port: guard.port, method: "CONNECT", path: `127.0.0.1:${TARGET_PORT}` });
            req.on("connect", (res, socket) => (socket.destroy(), resolve(res.statusCode ?? 0)));
            req.on("response", (res) => (res.resume(), resolve(res.statusCode ?? 0)));
            req.on("error", () => resolve(-1));
            req.end();
        });
        expect(connect).toBe(403);
        expect(received).toEqual([]);
    });

    it("hands a redirect back instead of following it, so the next hop is checked as a new request", async () => {
        received.length = 0;
        const r = await viaProxy(guard, "GET", `${T}/moved`);
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe(`${OFF}/elsewhere`);
        expect((await viaProxy(guard, "GET", String(r.headers.location))).status).toBe(403);
        expect(received.map((x) => `${x.server} ${x.path}`)).toEqual(["target /moved"]);
    });

    it("logs every request with method, host, path and verdict, and never the query string", async () => {
        const before = guard.counts().total;
        await viaProxy(guard, "GET", `${T}/api/books?token=SECRET-QUERY-1`);
        await viaProxy(guard, "DELETE", `${T}/api/books/1?token=SECRET-QUERY-2`);
        const c = guard.counts();
        expect(c.total).toBe(before + 2);
        expect(c.total).toBe(c.allowed + c.refused + c.failed);
        expect(guard.entries().length).toBe(c.total);
        const last = guard.entries().slice(-2);
        expect(last.map((e) => [e.method, e.host, e.path, e.verdict])).toEqual([
            ["GET", `127.0.0.1:${TARGET_PORT}`, "/api/books", "allowed"],
            ["DELETE", `127.0.0.1:${TARGET_PORT}`, "/api/books/1", "refused"],
        ]);
        expect(JSON.stringify(guard.entries())).not.toContain("SECRET-QUERY");
        expect(guard.entries().find((e) => e.method === "CONNECT")?.verdict).toBe("refused");
    });

    it("drops method-override headers before forwarding, so a GET cannot be turned into a write", async () => {
        received.length = 0;
        const r = await viaProxy(guard, "GET", `${T}/api/books`, undefined, { "X-HTTP-Method-Override": "DELETE", "X-HTTP-Method": "PUT", "X-Method-Override": "PATCH", "X-C4T-Anything": "1", "X-Kept": "yes" });
        expect(r.status).toBe(200);
        expect(received.length).toBe(1);
        const h = received[0]!.headers;
        for (const name of ["x-http-method-override", "x-http-method", "x-method-override", "x-c4t-anything"]) expect(h[name], name).toBeUndefined();
        expect(h["x-kept"]).toBe("yes");
    });

    it("drops method-override headers spelled with underscores or in another case, which a CGI-style server reads as the same header", async () => {
        received.length = 0;
        const r = await viaProxy(guard, "GET", `${T}/api/books`, undefined, { X_HTTP_Method_Override: "DELETE", "x_http-method": "PUT", X_METHOD_OVERRIDE: "PATCH", X_C4T_Source: "platform:checks", Proxy_Authorization: "Basic eDp5", X_Kept_Too: "yes" });
        expect(r.status).toBe(200);
        expect(received.length).toBe(1);
        const names = Object.keys(received[0]!.headers);
        expect(names.filter((n) => /method|c4t|proxy/i.test(n))).toEqual([]);
        expect(received[0]!.headers["x_kept_too"]).toBe("yes");
        for (const [name, passes] of [["X_HTTP_Method_Override", false], ["x-http-method-override", false], ["X_Http_Method", false], ["x_c4t_guard", false], ["accept", true], ["x_forwarded_for", true]] as const) expect(passesRequestHeader(name), name).toBe(passes);
    });

    it("never passes the platform's own marks back from the application's answer", async () => {
        const r = await viaProxy(guard, "GET", `${T}/forged`);
        expect(r.status).toBe(200);
        expect(r.text).toBe("the site's own words");
        expect(Object.keys(r.headers).filter((n) => /c4t/i.test(n))).toEqual([]);
        expect(r.headers["x-site"]).toBe("kept");
        expect(guard.entries().at(-1)).toMatchObject({ path: "/forged", verdict: "allowed", status: 200 });
    });

    it("refuses a _method query parameter other than GET or HEAD, in any spelling: nothing reaches the target", async () => {
        received.length = 0;
        for (const q of ["_method=DELETE", "_method=put", "%5Fmethod=PATCH", "_METHOD=POST", "a=1&_method=GET&_method=DELETE", "_method=", "_method=OPTIONS"]) {
            const r = await viaProxy(guard, "GET", `${T}/api/books?${q}`);
            expect(r.status, q).toBe(403);
            expect(r.text).toMatch(/_method query parameter/);
        }
        expect(received).toEqual([]);
        expect((await viaProxy(guard, "GET", `${T}/api/books?_method=GET`)).status).toBe(200);
        expect((await viaProxy(guard, "HEAD", `${T}/api/books?_method=head`)).status).toBe(200);
        expect(received.map((x) => x.method)).toEqual(["GET", "HEAD"]);
    });

    it("passes the logged path and refusal reason through the shared redaction", async () => {
        const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
        await viaProxy(guard, "GET", `${T}/reset/${token}`);
        await viaProxy(guard, "GET", `${T}/admin/${token}`);
        const [allowed, refused] = guard.entries().slice(-2);
        expect(allowed!.verdict).toBe("allowed");
        expect(allowed!.path).toBe("/reset/[hidden]");
        expect(refused!.verdict).toBe("refused");
        expect(refused!.path).toBe("/admin/[hidden]");
        expect(refused!.reason).toMatch(/excluded path/);
        expect(JSON.stringify(guard.entries())).not.toContain(token);
    });

    it("cannot start on a port that is taken, and says so", async () => {
        const busy = http.createServer();
        await new Promise<void>((r) => busy.listen(BUSY_PORT, "127.0.0.1", () => r()));
        try {
            await expect(startEgressGuard({ app, allowPrivate: true, port: BUSY_PORT })).rejects.toThrow(/EADDRINUSE/);
        } finally {
            await new Promise((r) => busy.close(r));
        }
    });

    it("refuses an HTTPS target outright, and points every proxy variable at the guard with nothing exempted", () => {
        expect(egressTargetProblem({ origin: "https://shop.example.com", urls: ["https://shop.example.com/"] })).toMatch(/served over HTTPS.*not run/);
        expect(egressTargetProblem({ origin: T, urls: [`${T}/`] })).toBeUndefined();
        const env = egressEnv("http://127.0.0.1:1");
        for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(env[k]).toBe("http://127.0.0.1:1");
        expect(env.NO_PROXY).toBe("");
        expect(env.no_proxy).toBe("");
    });
});

// ── the orchestration, with a fake scanner process ──────────────────────────────────────────────────────────────────────────────────
const FAKE_SCANNER = `
const http = require("node:http");
const proxy = new URL(process.env.HTTP_PROXY);
const T = process.env.FAKE_TARGET, OFF = process.env.FAKE_OFF;
const send = (method, url, body) => new Promise((res) => {
  const r = http.request({ host: proxy.hostname, port: proxy.port, method, path: url, headers: body ? { "content-length": String(body.length) } : {} }, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); });
  r.on("error", (e) => res("error " + e.code)); r.end(body);
});
const connect = (hp) => new Promise((res) => {
  const r = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: hp });
  r.on("connect", (x, s) => { s.destroy(); res(x.statusCode); }); r.on("response", (x) => { x.resume(); res(x.statusCode); }); r.on("error", (e) => res("error " + e.code)); r.end();
});
const direct = (url) => new Promise((res) => { http.get(url, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); }).on("error", (e) => res("error " + e.code)); });
(async () => {
  const out = {};
  if (process.env.FAKE_MODE !== "direct-only") {
    for (const m of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH", "TRACE"]) out[m] = await send(m, T + "/api/books", m === "POST" || m === "PUT" ? "a=1" : undefined);
    out.offScope = await send("GET", OFF + "/");
    out.excluded = await send("GET", T + "/admin/users");
    out.tunnel = await connect("127.0.0.1:" + new URL(T).port);
  }
  out.direct = await direct(T + "/direct-" + (process.env.FAKE_MODE || "mixed"));
  process.stdout.write(JSON.stringify(out) + "\\n");
})();
`;
const scannerFile = path.join(tmp, "fake-scanner.cjs");
fs.writeFileSync(scannerFile, FAKE_SCANNER);

/** A fake adapter whose tool is a real child process, started the way every adapter starts its tool, pointed at the run's guard. */
function processAdapter(mode: "mixed" | "direct-only", seen: { target?: ScanTarget; out?: Record<string, unknown> }, egressProxy = true): ScannerAdapter {
    return {
        id: "nuclei",
        name: "Fake scanner",
        documentationUrl: "https://example.com",
        description: "fake",
        capabilities: { progress: false, cancel: false, sharedDaemon: false, specDriven: false, aiDriven: false, egressProxy },
        available: async () => ({ scanner: "nuclei", state: "available", checkedAt: new Date().toISOString() }),
        validateConfig: async () => ({ ok: true, problems: [], checked: [] }),
        supports: () => true,
        validateScope: async (t) => ({ ok: true, allowed: t.urls, refused: [] }),
        async start(target) {
            seen.target = target;
            const env = target.egress ? egressEnv(target.egress.proxyUrl) : {};
            const outcome = await runProcess({ file: process.execPath, args: [scannerFile], env: { ...env, FAKE_TARGET: T, FAKE_OFF: OFF, FAKE_MODE: mode }, timeoutMs: 30_000 });
            seen.out = JSON.parse(outcome.stdout.trim()) as Record<string, unknown>;
            const results: ScanResultSet = { findings: [{ scannerRuleId: "r1", title: "A finding", severity: "low", category: "configuration", url: `${T}/`, description: "d", evidence: [{ kind: "note", label: "l", value: "v" }] }], coverage: { inspected: ["looked"], notInspected: [] }, reference: "fake-1" };
            return { scanner: "nuclei", reference: "fake-1", progress: async () => ({ percent: 100, message: "", done: true }), cancel: async () => undefined, results: async () => results, cleanup: async () => undefined };
        },
    };
}

function withDb(targetUrl = `${T}/`) {
    const dir = fs.mkdtempSync(path.join(tmp, "db-"));
    const db = new Db(path.join(dir, "t.db"));
    const repo = new Repo(db, new SecretBox(dir));
    const projectId = repo.createProject({ name: "Client A" }).id;
    const store = new SecurityStore(db);
    const application = store.createApplication(projectId, { name: "Shop", targetUrl, environment: "staging", scope: [], excludedPaths: ["/admin"], maxRequestsPerSecond: 10 });
    const authorization = store.addAuthorization(application.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm I am authorized to test this application.", confirmedByName: "Tester" });
    const assessment = store.createAssessment({ applicationId: application.id, authorizationId: authorization.id, startedBy: "Tester" });
    setProjectScanners(db, projectId, ["nuclei"]);
    return { db, application, assessmentId: assessment.id };
}
const settings = scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_SCANNER_MAX_RPS: "50", SECURITY_SCANNER_REQUEST_BUDGET: "500" });

describe("runScanners with the request guard and a fake scanner process", () => {
    it("lets only GET/HEAD/OPTIONS on in-scope addresses through, logs every request into the run, and the target sees a direct request without the guard's mark", async () => {
        const { db, application, assessmentId } = withDb();
        const seen: { target?: ScanTarget; out?: Record<string, unknown> } = {};
        received.length = 0;
        const out = await runScanners({ db, application, assessmentId, profile: "passive", signal: new AbortController().signal, target: { urls: [`${T}/`, `${T}/api/books`], origin: T }, settings, adapters: [processAdapter("mixed", seen)], egress: { allowPrivate: true } });
        expect(seen.target?.egress?.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(seen.out).toMatchObject({ GET: 200, HEAD: 200, OPTIONS: 200, POST: 405, PUT: 405, DELETE: 405, PATCH: 405, TRACE: 405, offScope: 403, excluded: 403, tunnel: 403, direct: 200 });
        // The target's own log: everything that came through the guard is GET/HEAD/OPTIONS on an allowed path; the one request without
        // the guard's mark is the direct attempt, which the guard could not see. The off-scope server received nothing at all.
        expect(received.filter((r) => r.via).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/books", "HEAD /api/books", "OPTIONS /api/books"]);
        expect(received.filter((r) => !r.via).map((r) => `${r.server} ${r.method} ${r.path}`)).toEqual(["target GET /direct-mixed"]);
        expect(received.some((r) => r.server === "off")).toBe(false);

        expect(out.outcomes[0]!.state).toBe("COMPLETED");
        const run = runsOfAssessment(db, assessmentId)[0]!;
        const log = run.coverage.requestLog ?? [];
        expect(log.length).toBe(11);
        expect(log.filter((e) => e.verdict === "allowed").map((e) => e.method)).toEqual(["GET", "HEAD", "OPTIONS"]);
        expect(log.filter((e) => e.verdict === "refused").length).toBe(8);
        expect(log.find((e) => e.method === "CONNECT")?.reason).toMatch(/cannot see the method or the address/);
        expect(run.coverage.inspected.join(" ")).toMatch(/Request guard: Fake scanner sent 11 requests through it.*3 allowed, 8 refused/);
        expect(run.coverage.notInspected.join(" ")).toMatch(/Only GET, HEAD and OPTIONS/);
        db.close();
    });

    it("throws away the results of a scanner that sent nothing through the guard (it went direct), and says why", async () => {
        const { db, application, assessmentId } = withDb();
        const seen: { target?: ScanTarget; out?: Record<string, unknown> } = {};
        received.length = 0;
        const out = await runScanners({ db, application, assessmentId, profile: "passive", signal: new AbortController().signal, target: { urls: [`${T}/`], origin: T }, settings, adapters: [processAdapter("direct-only", seen)], egress: { allowPrivate: true } });
        expect(received.map((r) => `${r.path} ${r.via}`)).toEqual(["/direct-direct-only false"]);
        expect(out.outcomes[0]!.state).toBe("FAILED");
        expect(out.outcomes[0]!.reason).toMatch(/sent no request through the platform's request guard.*not used/);
        expect(out.results).toEqual([]);
        db.close();
    });

    it("refuses the scan, without starting the tool, for an HTTPS application", async () => {
        const { db, application, assessmentId } = withDb("https://shop.example.com/");
        const seen: { target?: ScanTarget } = {};
        const out = await runScanners({ db, application, assessmentId, profile: "passive", signal: new AbortController().signal, target: { urls: ["https://shop.example.com/"], origin: "https://shop.example.com" }, settings, adapters: [processAdapter("mixed", seen)], egress: {} });
        expect(seen.target).toBeUndefined();
        expect(out.outcomes[0]!.state).toBe("FAILED");
        expect(out.outcomes[0]!.reason).toMatch(/served over HTTPS/);
        db.close();
    });

    it("refuses the scan, without starting the tool, when the guard cannot start", async () => {
        const { db, application, assessmentId } = withDb();
        const busy = http.createServer();
        await new Promise<void>((r) => busy.listen(BUSY_PORT, "127.0.0.1", () => r()));
        const seen: { target?: ScanTarget } = {};
        try {
            const out = await runScanners({ db, application, assessmentId, profile: "passive", signal: new AbortController().signal, target: { urls: [`${T}/`], origin: T }, settings, adapters: [processAdapter("mixed", seen)], egress: { allowPrivate: true, port: BUSY_PORT } });
            expect(seen.target).toBeUndefined();
            expect(out.outcomes[0]!.state).toBe("FAILED");
            expect(out.outcomes[0]!.reason).toMatch(/request guard could not be started.*refused/);
        } finally {
            await new Promise((r) => busy.close(r));
            db.close();
        }
    });

    it("refuses an adapter that cannot be pointed at the guard, and Promptfoo because it sends POST", async () => {
        const { db, application, assessmentId } = withDb();
        const seen: { target?: ScanTarget } = {};
        const out = await runScanners({ db, application, assessmentId, profile: "passive", signal: new AbortController().signal, target: { urls: [`${T}/`], origin: T }, settings, adapters: [processAdapter("mixed", seen, false)], egress: { allowPrivate: true } });
        expect(seen.target).toBeUndefined();
        expect(out.outcomes[0]!.reason).toMatch(/cannot be configured to send its requests through the platform's request guard/);
        expect(egressAdapterProblem(new PromptfooAdapter({ settings: scannerSettings({}) }))).toMatch(/POST/);
        for (const a of [new NucleiAdapter({ settings: scannerSettings({}) }), new SchemathesisAdapter({ settings: scannerSettings({}) }), new ZapAdapter({ settings: scannerSettings({}) })]) expect(egressAdapterProblem(a)).toBeUndefined();
        db.close();
    });
});

// ── the real adapters' wiring, through their fake hooks ────────────────────────────────────────────────────────────────────────────
const PROXY = "http://127.0.0.1:9715";
const target = (over: Partial<ScanTarget> = {}): ScanTarget => ({ applicationId: "app-1", origin: T, urls: [`${T}/`, `${T}/api/books`], excludedPaths: ["/admin"], maxRequestsPerSecond: 2, requestBudget: 100, timeoutMs: 60_000, authHeader: null, spec: null, aiInterface: null, egress: { proxyUrl: PROXY }, ...over });
const outcome = (stdout = "") => ({ code: 0, signal: null, stopped: false, stopReason: null, stdout, stderr: "", truncated: false, tookMs: 1 }) as never;

describe("the real adapters send their tool through the guard", () => {
    it("nuclei: -proxy and the proxy environment", async () => {
        const dir = path.join(tmp, "templates");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "get.yaml"), "id: get-headers\ninfo:\n  severity: info\n  tags: header\nhttp:\n  - method: GET\n    path: ['{{BaseURL}}/']\n");
        let seen: { args: string[]; env?: Record<string, string> } | undefined;
        const adapter = new NucleiAdapter({ settings: scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_NUCLEI_TEMPLATES: dir }), resolve: () => "/fake/nuclei", run: (async (o: { args: string[]; env?: Record<string, string> }) => ((seen = o), outcome(""))) as never });
        await (await adapter.start(target(), "passive", { signal: new AbortController().signal })).cleanup();
        expect(seen!.args[seen!.args.indexOf("-proxy") + 1]).toBe(PROXY);
        expect(seen!.env).toMatchObject({ HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, NO_PROXY: "" });
    });

    it("schemathesis: --proxy and the proxy environment", async () => {
        let seen: { args: string[]; env: Record<string, string> } | undefined;
        const adapter = new SchemathesisAdapter({
            settings: scannerSettings({ SECURITY_SCANNERS: "schemathesis" }),
            resolve: () => "/fake/schemathesis",
            run: (async (o: { args: string[]; env: Record<string, string> }) => (o.args.includes("--version") ? outcome("schemathesis, version 4.32.4") : ((seen = o), outcome()))) as never,
            readFile: async () => "",
        });
        const spec = { fileName: "api.json", text: JSON.stringify({ openapi: "3.0.3", paths: { "/api/books": { get: {} } } }) };
        await adapter
            .start(target({ spec }), "passive", { signal: new AbortController().signal })
            .then((h) => h.cleanup())
            .catch(() => undefined);
        expect(seen!.args[seen!.args.indexOf("--proxy") + 1]).toBe(PROXY);
        expect(seen!.env).toMatchObject({ HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, NO_PROXY: "" });
    });

    const zapSettings = (url = "http://127.0.0.1:9716") => scannerSettings({ SECURITY_SCANNERS: "zap", SECURITY_ZAP_URL: url, SECURITY_ZAP_API_KEY: "k" });
    const zapFake = (opts: { exclusions?: unknown; ignoreSet?: boolean } = {}) => {
        const calls: string[] = [];
        const state = { host: "", port: "", enabled: false };
        const fetchJson = (async (_b: string, c: string, _op: string, n: string, o: { query?: Record<string, unknown> } = {}) => {
            calls.push(`${c}/${n}${c === "network" && n.startsWith("set") ? ` ${JSON.stringify(o.query)}` : ""}`);
            if (c === "network" && n === "setHttpProxy" && !opts.ignoreSet) Object.assign(state, { host: String(o.query?.host), port: String(o.query?.port) });
            if (c === "network" && n === "setHttpProxyEnabled" && !opts.ignoreSet) state.enabled = String(o.query?.enabled) === "true";
            if (c === "network" && n === "getHttpProxy") return { httpProxy: { host: state.host, port: state.port } };
            if (c === "network" && n === "isHttpProxyEnabled") return { enabled: String(state.enabled) };
            if (c === "network" && n === "getHttpProxyExclusions") return opts.exclusions ?? { exclusions: [] };
            if (c === "pscan" && n === "recordsToScan") return { recordsToScan: "0" };
            if (c === "alert" && n === "alerts") return { alerts: [] };
            return { Result: "OK" };
        }) as never;
        return { calls, state, fetchJson };
    };

    it("ZAP: points the daemon's upstream proxy at the guard before any request, reads it back, and restores it afterwards", async () => {
        const f = zapFake();
        const h = await new ZapAdapter({ settings: zapSettings(), fetchJson: f.fetchJson, sleep: async () => undefined }).start(target(), "passive", { signal: new AbortController().signal });
        await h.cleanup();
        const set = f.calls.findIndex((c) => c.startsWith("network/setHttpProxy {"));
        expect(f.calls[set]).toBe('network/setHttpProxy {"host":"127.0.0.1","port":"9715"}');
        expect(set).toBeLessThan(f.calls.findIndex((c) => c === "core/accessUrl"));
        expect(f.calls).toContain("network/getHttpProxyExclusions");
        expect(f.calls.at(-1)).toBe('network/setHttpProxyEnabled {"enabled":false}');
        expect(f.state.enabled).toBe(false);
    });

    it("ZAP: refuses a daemon on another machine, one that does not confirm the setting, and one with proxy exclusions - and restores", async () => {
        const signal = new AbortController().signal;
        await expect(new ZapAdapter({ settings: zapSettings("http://zap.internal:8090"), fetchJson: zapFake().fetchJson }).start(target(), "passive", { signal })).rejects.toThrow(/another machine/);
        const ignored = zapFake({ ignoreSet: true });
        await expect(new ZapAdapter({ settings: zapSettings(), fetchJson: ignored.fetchJson }).start(target(), "passive", { signal })).rejects.toThrow(/did not confirm/);
        expect(ignored.calls).not.toContain("core/accessUrl");
        const excl = zapFake({ exclusions: { exclusions: [{ host: "127.0.0.1", enabled: "true" }] } });
        await expect(new ZapAdapter({ settings: zapSettings(), fetchJson: excl.fetchJson }).start(target(), "passive", { signal })).rejects.toThrow(/proxy exclusions/);
        expect(excl.calls).not.toContain("core/accessUrl");
        expect(excl.state.enabled).toBe(false);
    });

    it("an adapter given no guard behaves as before (no proxy flag)", async () => {
        let args: string[] = [];
        const dir = path.join(tmp, "templates");
        const adapter = new NucleiAdapter({ settings: scannerSettings({ SECURITY_SCANNERS: "nuclei", SECURITY_NUCLEI_TEMPLATES: dir }), resolve: () => "/fake/nuclei", run: (async (o: { args: string[] }) => ((args = o.args), outcome(""))) as never });
        await (await adapter.start(target({ egress: null }), "passive", { signal: new AbortController().signal })).cleanup();
        expect(args).not.toContain("-proxy");
    });
});

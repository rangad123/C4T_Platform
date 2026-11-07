/**
 * Private and local addresses on a runner (src/agent/address-guard.ts): the rules, the run's config, and the REAL agent running REAL
 * Playwright runs for a fake platform (tests/fixtures/fake-platform.ts) whose hello answer carries the runner's switch.
 *
 * A local site stands in for a public one (trustForTests, the same seam GuardProxy has); a second local server stands for an address on
 * the person's own network and counts every request it gets.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/runner-address-guard.test.ts
 * Ports: fake platforms 8240 and 8243, the "public" site 8241, the "private" server 8242.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressProblem, addressesOf, proxyTestsConflict, refusesPrivateAddresses, runAddressRefusal, trustForTests, type Lookup } from "../src/agent/address-guard.js";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { withTestProxy } from "../src/engine/net/test-proxy.js";
import { configFor } from "../src/engine/validation/runner.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { FakePlatform } from "./fixtures/fake-platform.js";

const PUB_PORT = 8241;
const PRIV_PORT = 8242;
const PUB = `http://127.0.0.1:${PUB_PORT}`;
const PRIV = `http://127.0.0.1:${PRIV_PORT}`;
const TOKEN = "aitg_AddressGuardToken0123456789abcdefghij";

// ── the rules (no browser, no network) ──────────────────────────────────────

const lookupOf =
    (table: Record<string, string[]>): Lookup =>
    async (host) => {
        const found = table[host];
        if (!found) throw new Error("ENOTFOUND");
        return found.map((address) => ({ address }));
    };

describe("which runner refuses private addresses", () => {
    const runner = (privateTargets: boolean) => ({ runner: { id: "r1", kind: "personal" as const, customScripts: false, privateTargets } });
    it("follows the platform's switch, the newest word first, and keeps today's rule for an older platform", () => {
        expect(refusesPrivateAddresses(runner(false), {}, {})).toBe(true);
        expect(refusesPrivateAddresses(runner(true), {}, {})).toBe(false);
        expect(refusesPrivateAddresses({}, {}, {})).toBe(false);
        expect(refusesPrivateAddresses(runner(true), { privateTargets: false }, {})).toBe(true);
        expect(refusesPrivateAddresses(runner(false), { privateTargets: true }, {})).toBe(false);
    });
    it("refuses them whatever the platform says when this computer's own setting does (stricter only)", () => {
        expect(refusesPrivateAddresses(runner(true), { privateTargets: true }, { BLOCK_PRIVATE_TARGETS: "true" })).toBe(true);
        expect(refusesPrivateAddresses({}, {}, { BLOCK_PRIVATE_TARGETS: "false" })).toBe(false);
    });
});

describe("an address, looked up on the runner", () => {
    const lookup = lookupOf({ "shop.example": ["93.184.216.34"], "router.example": ["93.184.216.34", "192.168.1.1"], "intranet.example": ["10.0.0.5"] });
    it("refuses loopback, the local network and link-local addresses, by number and by what a name leads to", async () => {
        for (const a of ["http://127.0.0.1:3000/", "http://192.168.1.1/cgi-bin/admin", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://localhost:8080/", "http://10.1.2.3/"]) {
            expect(await addressProblem(a, lookup), a).toMatch(/private or local address/);
        }
        expect(await addressProblem("https://router.example/", lookup)).toMatch(/leads to a private or local address on this computer's network/);
        expect(await addressProblem("https://intranet.example/", lookup)).toMatch(/owner can allow them on the Runners page/);
    });
    it("lets a public address through, and says so plainly when a name cannot be found", async () => {
        expect(await addressProblem("https://shop.example/cart", lookup)).toBeUndefined();
        expect(await addressProblem("http://93.184.216.34/", lookup)).toBeUndefined();
        expect(await addressProblem("https://nowhere.example/", lookup)).toMatch(/could not be found from this computer/);
        // Not an http(s) address: left to the run (a placeholder, an app id).
        expect(await addressProblem("com.example.app", lookup)).toBeUndefined();
    });
    it("checks the site, the API and every web address of the environment", async () => {
        expect(addressesOf({ baseUrl: "https://shop.example", apiBaseUrl: "https://shop.example", vars: { AUTH: "https://intranet.example/login", NAME: "Ada" } })).toEqual(["https://shop.example", "https://intranet.example/login"]);
        expect(await runAddressRefusal({ baseUrl: "https://shop.example" }, lookup)).toBeUndefined();
        expect(await runAddressRefusal({ baseUrl: "https://shop.example", apiBaseUrl: "http://10.0.0.9/api" }, lookup)).toMatch(/^The run was not started: 10\.0\.0\.9 is a private or local address/);
        expect(await runAddressRefusal({ baseUrl: "https://shop.example", vars: { AUTH: "https://intranet.example/login" } }, lookup)).toMatch(/intranet\.example leads to a private/);
    });
    it("refuses a run that would go through a company proxy, which the runner cannot check", () => {
        expect(proxyTestsConflict({ AITP_PROXY_TESTS: "1", HTTPS_PROXY: "http://proxy.corp:3128" })).toMatch(/--proxy-tests/);
        expect(proxyTestsConflict({ AITP_PROXY_TESTS: "1" })).toBeUndefined();
        expect(proxyTestsConflict({ HTTPS_PROXY: "http://proxy.corp:3128" })).toBeUndefined();
    });
});

describe("the run's config", () => {
    const base = configFor([]);
    it("is unchanged without the guard (the platform never sets it)", () => {
        expect(withTestProxy(base, {})).toBe(base);
    });
    it("sends the browser and the API calls through the guard, loopback included, in place of any company proxy", () => {
        const c = withTestProxy(base, { AITP_ADDRESS_GUARD: "http://127.0.0.1:41234", AITP_PROXY_TESTS: "1", HTTPS_PROXY: "http://proxy.corp:3128" });
        expect(c).toContain('proxy: { server: "http://127.0.0.1:41234", bypass: "<-loopback>" }');
        expect(c).not.toContain("testProxy");
        // Variants keep the top-level proxy (projects do not set one).
        expect(withTestProxy(configFor([{ name: "firefox", device: "Desktop Firefox" }]), { AITP_ADDRESS_GUARD: "http://127.0.0.1:41234" })).toContain('proxy: { server: "http://127.0.0.1:41234"');
    });
    it("stops the run rather than letting it out unguarded when the guard's address is not one it can use", () => {
        expect(() => withTestProxy(base, { AITP_ADDRESS_GUARD: "http://10.0.0.1:3128" })).toThrow(/address guard could not be applied/);
        expect(() => withTestProxy("export default {}\n", { AITP_ADDRESS_GUARD: "http://127.0.0.1:41234" })).toThrow(/address guard could not be applied/);
    });
});

// ── the real agent, real runs ───────────────────────────────────────────────

let tmp: string;
let pub: http.Server;
let priv: http.Server;
const privateHits: string[] = [];

const spec = (testId: string, title: string, kind: "web" | "api", steps: unknown[]) => TestSpecSchema.parse({ testId, title, kind, category: "Agent", steps });
const script = (s: ReturnType<typeof spec>, fw: "playwright" | "playwright-api") => {
    const r = renderScript(s, fw, { baseUrl: PUB });
    return { testId: s.testId, filename: r.filename, content: r.content };
};
const visible = (text: string) => ({ action: "assert", check: "visible", locator: { by: "text", value: text } });
const homePage = () => script(spec("WEB-101", "The public home page opens", "web", [{ action: "navigate", url: `${PUB}/` }, visible("Welcome to the public site")]), "playwright");
const redirectPage = () => script(spec("WEB-102", "A redirect to the person's network", "web", [{ action: "navigate", url: `${PUB}/go` }, visible("SECRET-PAGE")]), "playwright");
const redirectApi = () => script(spec("API-101", "An API redirect to the person's network", "api", [{ action: "request", method: "GET", path: "/api/go", auth: "default", description: "" }, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" }]), "playwright-api");

let counter = 0;
const offer = (adapterId: string, scripts: TaskOffer["scripts"], baseUrl = PUB, extra: Partial<TaskOffer> = {}): TaskOffer => ({
    taskId: `guard-${++counter}-${Math.random().toString(16).slice(2, 8)}`,
    jobId: "job-guard",
    adapterId,
    leaseSeconds: 60,
    workers: 1,
    timeoutMs: 120_000,
    scripts,
    env: { baseUrl, apiBaseUrl: baseUrl, headless: true },
    ...extra,
});

/** The hello answer of a platform with the runner switches (protocol 2 platforms send them; the fake one does not). */
function withSwitch(privateTargets: boolean): typeof fetch {
    return async (input, init) => {
        const res = await fetch(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith("/api/agent/hello") || !res.ok) return res;
        const body = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...body, runner: { id: "runner-guard", kind: "personal", customScripts: false, privateTargets } });
    };
}

async function startAgent(fake: FakePlatform, privateTargets: boolean, env: NodeJS.ProcessEnv = {}) {
    const { log, lines } = memoryLogger();
    const agent = new Agent({
        config: { baseUrl: fake.url, token: TOKEN, name: "Guard agent", concurrency: 1, workDir: path.join(tmp, `work-${privateTargets}`), allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
        log,
        env: { ...process.env, BLOCK_PRIVATE_TARGETS: "", ...env },
        fetchImpl: withSwitch(privateTargets),
        heartbeatMs: 300,
        backoff: { baseMs: 50, maxMs: 200 },
    });
    const done = agent.run();
    const end = Date.now() + 60_000;
    while (!lines.join("\n").includes("Connected to the platform")) {
        if (Date.now() > end) throw new Error("the agent did not connect");
        await new Promise((r) => setTimeout(r, 50));
    }
    return { lines, stop: async () => (agent.stop(), done) };
}

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-address-guard-"));
    pub = http.createServer((req, res) => {
        const p = new URL(req.url ?? "/", PUB).pathname;
        if (p === "/go") return void res.writeHead(302, { location: `${PRIV}/secret` }).end();
        if (p === "/api/go") return void res.writeHead(302, { location: `${PRIV}/api/secret` }).end();
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="en"><head><title>Public</title></head><body><h1>Welcome to the public site</h1></body></html>`);
    });
    priv = http.createServer((req, res) => {
        privateHits.push(req.url ?? "/");
        if ((req.url ?? "").startsWith("/api/")) return void res.writeHead(200, { "content-type": "application/json" }).end(`{"secret":"SECRET-PAGE"}`);
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="en"><head><title>Router</title></head><body><h1>SECRET-PAGE</h1></body></html>`);
    });
    await new Promise<void>((r) => pub.listen(PUB_PORT, "127.0.0.1", r));
    await new Promise<void>((r) => priv.listen(PRIV_PORT, "127.0.0.1", r));
    // The local "public" site is public for the guard; the "private" one is what it is: 127.0.0.1.
    trustForTests([`127.0.0.1:${PUB_PORT}`]);
});

afterAll(async () => {
    trustForTests([]);
    await new Promise((r) => pub?.close(r));
    await new Promise((r) => priv?.close(r));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a runner whose owner did not allow private addresses", () => {
    let fake: FakePlatform;
    let a: Awaited<ReturnType<typeof startAgent>>;
    beforeAll(async () => {
        fake = new FakePlatform(8240, { token: TOKEN });
        await fake.start();
        a = await startAgent(fake, false);
    }, 90_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    it("refuses a run whose site is on the person's network, before anything starts", async () => {
        privateHits.length = 0;
        const t = offer("playwright", [homePage()], PRIV);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^The run was not started: 127\.0\.0\.1:8242 is a private or local address\. .*Runners page/);
        expect(r.runs).toEqual([]);
        expect(privateHits).toEqual([]);
    }, 60_000);

    it("refuses a recording that starts on the person's network, with no browser opened", async () => {
        const t = offer("playwright", [], PUB, { kind: "record", record: { recordingId: "rec-1", startUrl: `${PRIV}/`, headed: false, idleMinutes: 5, totalMinutes: 5, maxSteps: 10 } });
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^The recording was not started: 127\.0\.0\.1:8242 is a private or local address/);
        expect(privateHits).toEqual([]);
    }, 60_000);

    it("runs a public site, and a redirect to the person's network is refused in the real browser and in API calls", async () => {
        privateHits.length = 0;
        const t = offer("playwright", [homePage(), redirectPage()]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId, 120_000);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs.find((x) => x.testId === "WEB-101")?.status).toBe("passed");
        expect(r.runs.find((x) => x.testId === "WEB-102")?.status).toBe("failed");

        const api = offer("playwright-api", [redirectApi()]);
        fake.enqueue({ offer: api });
        const ra = await fake.result(api.taskId, 120_000);
        expect(ra.ok, ra.error).toBe(true);
        expect(ra.runs[0]?.status).toBe("failed");
        // The private server never saw a single request: the guard refused the hop before connecting.
        expect(privateHits).toEqual([]);
    }, 180_000);
});

describe("a runner whose owner allowed private addresses", () => {
    let fake: FakePlatform;
    let a: Awaited<ReturnType<typeof startAgent>>;
    beforeAll(async () => {
        fake = new FakePlatform(8243, { token: TOKEN });
        await fake.start();
        a = await startAgent(fake, true);
    }, 90_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    it("opens the person's own network as before: the redirect is followed", async () => {
        privateHits.length = 0;
        const t = offer("playwright", [redirectPage()]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId, 120_000);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs[0]?.status).toBe("passed");
        expect(privateHits).toContain("/secret");
    }, 180_000);
});
